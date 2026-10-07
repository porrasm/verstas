# Sandbox design

This is the document to review before trusting Verstas with a repository.
It names every boundary between an agent and your machine, the exact
mechanism that enforces it, and the risks that remain. Every later change to
a boundary must update this file in the same commit.

## Threat model

The agent is untrusted code. It runs with a long-lived token for your Claude
subscription and full autonomy inside its box (`--permission-mode
bypassPermissions`, because there is nobody to answer prompts at night). It
may be confused, mistaken, or steered by content it reads in the repository.
We therefore assume it will try, at some point, to:

- read or change files outside its workspace;
- reach hosts on the network we did not approve;
- run something on the host, now or later (hooks, config, cron);
- keep running or keep data after the session is deleted;
- exhaust CPU, memory, pids or disk.

Out of scope: escaping the Docker Desktop virtual machine itself, and the
model provider. Anthropic's API is the one trusted external party by
decision; your code goes there.

## Capability inside, boundary outside

The box is meant to become whatever development environment a project
needs, without a person approving each install at night. So power goes
into the box and control stays outside it:

- **Inside**, the agent is uid 1000 with passwordless `sudo`. It installs
  packages, runs services, writes anywhere in the container. Every sudo
  command is logged to `workspace/.verstas/logs/sudo.log` and shown on the
  session page; that log is a record, not a control, since root can edit it.
- **Outside** are the boundaries that protect your machine, and none of
  them depends on the user inside the container: one bind mount (the
  workspace), the internal network whose only exit is the allowlist proxy,
  no Docker socket, no `--privileged`, no devices, Docker's default seccomp
  profile, and the resource limits.

A compromised agent that owns the box owns one disposable session. It
still cannot read your disk, reach a host you did not allow, or start a
container on your machine. What it can do with root that uid 1000 could
not is attack the kernel through the syscalls the default seccomp profile
allows; that is the same surface any `docker run` you type exposes, and on
macOS it sits inside Docker Desktop's VM.

## Where the host app runs, and why not in Docker

The host app (board, loop, UI) runs as an ordinary Node process on your
machine, not as a container. Three reasons:

1. **The Docker socket stays with you.** A container that can start other
   containers with bind mounts is root on the host. Giving that to the web
   app would make the web app the weakest point. On the host it runs with
   your user's permissions and the `docker` CLI you already trust.
2. **Cloning needs to read your repositories.** The app makes a fresh
   `git clone` of each work target into the session. From a container that
   would mean mounting your home directory into it.
3. **No path mapping.** Bind-mount sources are host paths; an app in a
   container would have to know both views of every path.

The desktop window (`npm start`, Electron) changes none of this: the host
app runs inside the window's main process with the same user and the same
`docker` CLI, and the window is a browser on `http://127.0.0.1:4700` with
Node integration off and a sandboxed renderer. Links that leave the app
open in your browser.

Only sessions are containerized. That is the part that holds untrusted code.

## Boundary 1: what enters a session

A session directory is created under the sessions root you chose, for
example `~/verstas/sessions/<id>/`. Inside, `workspace/` is the only
directory a container ever sees.

- **Repositories are cloned, never mounted.** `git clone --no-hardlinks
  <path> workspace/<name>`. Plain local clones hard-link object files into
  the source repository; a process that could overwrite a hard-linked object
  would corrupt your real repository, hence `--no-hardlinks`. Clones carry no
  hooks and no git-ignored files, so `.env`, keys and build output stay
  home. The clone's `origin` remote is removed, because it points at a host
  path that means nothing inside the box.
- **Zip attachments** are extracted into `workspace/attachments/<name>/`
  after every entry name is checked: no absolute paths, no `..` segments, no
  symlinks, a size limit per file and in total. Entries that fail are
  skipped and listed in the session log.
- **Nothing else is copied.** No dotfiles from your home, no SSH agent, no
  npm or pip credentials.

## Boundary 2: the container

One container per session, started by the host app with exactly these
options (the argument builder is `src/sandbox/docker-args.ts`, unit-tested
so that a change here shows up as a test diff):

| Option | Why |
| --- | --- |
| `--network verstas-<id>` | A per-session network created with `--internal`: no default route, no gateway, no `host.docker.internal`. The only other member is the proxy. |
| `--user 1000:1000` | The agent's user. It has passwordless `sudo` (`/etc/sudoers.d/verstas` in the image), logged to the workspace. |
| `--cap-drop ALL` then `--cap-add` CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP, SETFCAP, NET_BIND_SERVICE, SYS_CHROOT, AUDIT_WRITE | Docker's default set minus NET_RAW (raw sockets) and MKNOD (device nodes). They exist for root inside the box (the agent through sudo): apt drops to its `_apt` user, dpkg chowns installed files, installers write into root-owned trees. With `--cap-drop ALL` alone every apt-get as root failed with `setgroups: Operation not permitted`. None of these crosses a namespace; SYS_ADMIN, NET_ADMIN, SYS_PTRACE and SYS_MODULE are never added. |
| `--pids-limit 2048`, `--memory <n>`, `--cpus <n>` | A runaway build or fork bomb stays inside the budget you set per session. |
| `--tmpfs /tmp:exec,size=2g`, `TMPDIR=/tmp` | Scratch space that disappears with the container. `exec` because installers and builds run binaries from the temp directory; Docker's default tmpfs is `noexec`. |
| `-v <session>/workspace:/workspace` | The one read-write bind mount. On a Linux host it keeps the host's real ownership, so what the host app wrote (clones, an import, notes) would belong to the host user, root on a server, and the agent could not write at all; each time the box is brought up, a root exec `chown`s to uid 1000 whatever the agent does not own yet (`ownWorkspaceArgs`). Docker Desktop maps ownership itself, so the step is skipped there (`config.linuxHost`). |
| `-v verstas-<id>-home:/home/agent`, `HOME=/home/agent` | A named Docker volume, not a host path: package caches, browsers and toolchains the agent installs survive a container recreate without counting against the workspace limit or crossing the macOS file-sharing layer. Labelled with the session and removed when the session is deleted. |
| `-v <repo>/dist/src/worker:/opt/verstas:ro` | Our worker and board MCP code, read-only, over the image's own copy, so a fix ships with `npm run build` instead of an image rebuild. The agent can read it (it is not secret) and cannot change it. |
| `--env` only for `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `HOME`, `TMPDIR` and the session id | Nothing from your environment leaks in, and no secret: the tokens go to each worker's exec only (Boundary 6). |
| `--init`, `--restart no`, `--label verstas.session=<id>` | Clean signal handling, no resurrection, and cleanup can find everything by label. |

Not used, and why:

- `--privileged`, any `--device`, the Docker socket: never. These are the
  three ways out of a container.
- `--security-opt no-new-privileges`: removed on purpose, because it blocks
  `sudo`. With root inside the box intended, the flag protected nothing
  that the boundaries above do not.
- `--read-only` root filesystem: not in the MVP. Installs requested by the
  agent write under `/usr` and `/opt`, and the container is disposable. It
  can be added later with explicit writable mounts.
- Nested Docker (docker-in-docker, sysbox): never in the MVP. Services the
  agent needs (Postgres, Redis, a Kapula server) are installed with sudo
  and run as plain processes under `svc`, the image's small supervisor.

## Boundary 3: the network

Containers on an `--internal` network cannot reach the internet, the host,
or other Docker networks. The only member besides the session container is a
**proxy container** (`node:22-alpine` running `dist/proxy/proxy.js`,
bind-mounted read-only) that is attached to both the internal network and
the default bridge, so it alone has egress.

- The proxy runs with `--restart on-failure:5`: it is stateless code of
  ours, and a session has no egress without it. The session container
  itself keeps `--restart no`. The loop also checks that proxy and
  container are up before every ticket and starts a stopped one.
- The session container gets `HTTPS_PROXY=http://proxy:3128` and the same
  for `HTTP_PROXY`. Tools that honour the variables (git, npm, pip, curl,
  Claude Code) work; tools that do not simply fail to connect, which is the
  desired failure mode.
- **Allowlist.** A file in the session directory, `proxy/allowlist.json`.
  The `proxy/` directory (never the file alone) is mounted read-only into
  the proxy, which re-reads the file when its inode, mtime or size changes,
  so approving a request takes effect within two seconds without a restart.
  The host writes the file by rename; a single-file bind mount would keep
  showing the old inode, which is how approvals once failed to apply. Entries are `host` or
  `*.suffix`, with an optional port. HTTPS (`CONNECT`) is allowed only to
  port 443 of listed hosts. Plain HTTP is allowed only to the agent API
  (below). Everything else gets `403` and a log line.
- **Denied attempts are events.** The proxy logs `denied host:port` to
  stdout; the host app collects container logs and shows them on the
  session page. A denied host is one click from becoming a request to
  approve.
- **Network packs.** The allowlist is built from named packs of toolchain
  download hosts (`src/network/packs.ts`: node, python, debian, github,
  playwright, cypress, chromium, rust, go, jvm, ruby, dotnet) plus extra hosts you
  type. A new session gets node, python, debian and github; ticking a
  repository on the New session form ticks the packs its tracked manifests
  imply (read on the host as data, never run). `api.anthropic.com` is
  always in. A worker can ask for a whole pack with a `pack` request; you
  approve it like a host. Each pack host is a place data can go, like any
  allowlisted host; `storage.googleapis.com` (chromium, go) is the
  broadest of them.
- DNS inside the internal network resolves only container names. External
  names are resolved by the proxy, which is one more reason tools without
  proxy support cannot reach out.

## Boundary 4: the agent API

The agent needs to read and move tickets. It does so through a small stdio
MCP server in the image (`verstas-board`) that calls the host app's **agent
API**: a separate Express app on port **4701**, listening on all interfaces
so that the proxy container can reach it at `host.docker.internal:4701`
(on Linux the proxy is started with `--add-host
host.docker.internal:host-gateway`).

- Every request carries a **run token**, random per worker, in an
  `Authorization` header, issued when the worker starts and revoked when
  it ends. A token grants access to one run's board, its notes and its
  request inbox, nothing else. Its role limits it further: a worker
  cannot move tickets at all; a lead may claim a ready ticket and submit
  the one it holds, but never move one to `done`, which only the
  harness's judge does after gates and an independent reviewer. A ticket's
  review mode (`full`, `checks`, `none`), which decides whether that
  reviewer and those gates run, is yours alone: the agent API strips it
  from tickets an agent files and no agent route changes it, so an agent
  cannot judge its own work by filing it as "no review". The same goes
  for a repository's check command: only you set it. The script it runs
  lives in the repository, so an agent can change that script in a
  ticket; the change is in the diff the reviewer reads.
- The proxy allows plain HTTP only to `host.docker.internal:4701` and only
  under the path prefix `/agent/`. The UI and the session management API
  live on **4700**, bound to `127.0.0.1`, which no container can reach.
- The agent API never exposes: creating or deleting sessions, Docker
  operations, the sessions root, other runs, or approving its own requests.

## Boundary 5: git after cloning

The host app never runs `git` inside a workspace after the clone. A
repository the agent can write is a repository whose `.git/config` and
`.git/hooks` the agent controls, and host git would execute them on your
machine (`core.fsmonitor`, `core.sshCommand`, `pre-commit`). So:

- Commits per ticket are made by the harness with `docker exec` **inside
  the container**, as the agent user, with a fixed author. The harness
  passes `-c core.hooksPath=/dev/null` as well, out of habit.
- **Export is a git bundle**, created inside the container and written to
  `<session>/export/<repo>.bundle`. A bundle is pure data: fetching from it
  on the host runs no code from the repository. The UI tells you the exact
  `git fetch <bundle> <branch>` line.
- **Apply to repo** does the fetch for you: host git reads the bundle (pure
  data) and writes into your own checkout, force-updating only the branch
  `verstas/<session>` and refusing if that branch is checked out. The
  workspace's `.git` is still never read by host git.
- **A session archive** (Export session) carries each clone as a bundle
  made the same way. Importing it runs host git only in a repository it
  has just created empty (no template, nothing from the archive's `.git`),
  fetching from the bundle: the same footing as the first clone. The
  workspace's other files are read as files, never followed through a
  symlink, and unpacked with the attachment checks.
- Do not `git fetch` or `git pull` directly from `workspace/<repo>` on the
  host. The UI does not offer it and this document is why.

## Boundary 6: secrets

Two secrets enter a session per worker, and neither is in the container's
environment. Each worker's `docker exec` passes them by name only
(`-e CLAUDE_CODE_OAUTH_TOKEN`, or the chosen agent's variable), with the
value in the docker CLI's own environment, so they never appear in a
command line on the host or in the box, and setup scripts, recipes, gates
and harness git do not see them.

- The agent's credential: `CLAUDE_CODE_OAUTH_TOKEN` (made once with
  `claude setup-token`), `VERSTAS_CODEX_AUTH` (the contents of Codex's
  `auth.json`) or `CURSOR_API_KEY`, stored in the host app's secrets file
  with mode `0600`. The worker and what it starts can read it, as any
  process can read its own credentials, and with sudo in the box so can
  root. Each works only against the hosts its network pack permits.
  Codex rotates its login during a run; the driver writes it to a private
  `CODEX_HOME` under `/tmp` for the duration of the worker, hands the
  rotated file back to the harness on the worker's stdout (a line the
  harness stores and never logs), and removes the directory. Nothing
  under the session directory or the home volume holds a credential
  (docs/DRIVERS.md).
- The run's board token, scoped as described above.

**Commits are scanned.** Before the harness commits, it reads each repo's
staged diff on the host and looks for every agent credential (the Claude
token, the Cursor key, the tokens inside the Codex login). A repo where one
appears is not committed (its changes are unstaged and kept), and a ticket
that would have been done is blocked with the reason. This keeps the
token out of bundles and out of "Apply to repo". Taking the token out of
the box entirely, with the proxy adding it to requests, is backlog V-04.

Secrets requested by the agent (a third-party API key) are a later feature.
When added, they are injected the same way and the agent sees only the
variable name in its context.

## Boundary 7: root inside the box

The agent installs system packages itself with `sudo`; see "Capability
inside, boundary outside" above. The `root_script` request kind, through
which a worker asked you to run bash as root, is retired: the agent API
refuses it, and old requests of that kind are shown as instructions with
their script. Root scripts approved before the change are still replayed
when a container is recreated without a snapshot. What follows describes
the root paths for text the agent did not run itself at that moment.

Root here is root in a container with Docker's default capabilities minus
raw sockets and device nodes, under the default seccomp profile, not on your
machine (see
Boundary 2 and the Residual risks), and it owns the container: a
malicious install could replace `node`, `git` or `claude` for every later
worker in that session. The session is the unit you throw away.

**The setup recipe**, `notes/setup.sh`, is written by the setup worker and
replayed when the container is recreated, as the agent user with sudo
available, logged to `<session>/setup/recipe.log`. It is agent-written text
that reaches a root-capable shell without a person reading it first; that
gives the agent nothing it did not already have through sudo, and it never
runs outside the session container.

**Recipes** (formerly setup scripts) are the other path: bash in the
library, either written by you (runs as root) or saved from a session's
`notes/setup.sh` (runs as the agent, with sudo),
copied into the session at creation, run once as root with `bash -e` when
the container is created (and again on recreate or re-run), output logged
to `<session>/setup/<name>.log`. The agent never writes or edits them; it
can read the copies. The hosts a script declares join the session
allowlist, which is the one place a script widens the boundary, visibly.

Everything else a worker needs from a person goes through the other action
kinds of the same request: `instruction` (a website to configure, a file
to place) and `question` (a decision). Those run nothing; you act, you
answer, the ticket resumes when every action is decided.

The container is created once per session and recreated only when its
image, limits, mounts or sandbox flags change (the flags are versioned in
`SANDBOX_VERSION`); so what you install stays for the session.

## Cleanup

Everything a session creates is labelled `verstas.session=<id>`: the
network, the proxy, the session container, the home volume and the
snapshot images. Deleting a session removes all of them, then the
directory.

## Snapshots

When you confirm the environment, the host commits the session container
to `verstas-session-<id>:latest` (`docker commit`; the workspace bind mount
and the home volume are not part of it). A recreated container starts from
that image while the base image is the one it was taken from; otherwise the
recipe is replayed on the base image. The snapshot holds whatever the agent
installed, so it is exactly as trusted as the session: it is never pushed
anywhere, and another session uses it only when you start that session
from this one's environment (below). `verstas doctor` lists labelled
resources without a matching directory and offers to remove them.

Importing an archive over the same session on the same machine ("Replace",
with "Keep this machine's environment" ticked, the default) removes the
container, proxy and network but keeps the home volume and the snapshot,
and the imported session keeps the snapshot record. Archives never carry
a volume or an image, so an import on another machine, or as a copy, has
neither.

## A session from another session's environment

"Start from: Environment of <session>" on the New session page (or "New
session from this environment" on a session page) gives a fresh board on a
copy of an initialized session's box. Everything is copied, nothing is
shared, and the source is never modified:

- The **home volume** is copied into the new session's own volume by a
  throwaway root container on no network, the source mounted read-only
  (`cp -a`, so owners and modes survive). Refused while the source has a
  run going: a volume copied while a worker writes to it is inconsistent.
- The **snapshot**, when the source has a usable one, becomes the new
  session's own image, built `FROM` it under the new session's label. Not
  a `docker tag`: a tag shares the image id and so the old label, and
  deleting the source would delete it.
- **Settings** (image, recipes, root scripts, network, limits, caps,
  agents, mode, setup instructions) and the box's notes (env.md, setup.sh,
  tools/, INDEX.md; brief.md and learnings.md unless you untick them; all
  notes but the handoff state.md on request; attachments on request).
- **Repositories** are fresh clones from your checkouts, or from the
  source's run branch to carry its unapplied commits: bundled inside the
  source's container and cloned from the bundle, which is pure data.
- The confirmed **readiness** comes along when the setup instructions are
  unchanged, and initialization then skips the setup worker; changed
  instructions leave it out so the setup worker checks the box again.

The new session comes up initialized through the usual path. If any step
fails, its volume, snapshot image and directory are removed. It inherits
the source's trust: whatever the source's agents put in the volume or the
snapshot is in the copy.

## Residual risks, stated plainly

- **Allowlisted hosts are channels.** Anything on the allowlist can receive
  data the agent chooses to send. The package registries accept uploads
  from authenticated users, so never put a registry token in a session. Keep
  the list short and per session.
- **The model provider sees your code.** By your decision; it is the point.
- **Disk.** Container writes land in `workspace/` on your disk. The host
  app checks the directory size between tickets and pauses the run over a
  configurable limit; it cannot stop a single write mid-ticket. The home
  volume and anything installed into the container's own filesystem have
  no per-session limit; they share Docker's disk (`docker system df`).
- **Proxy correctness.** The allowlist proxy is about two hundred lines of
  TypeScript with unit tests for the matcher and the request filter. It is
  small enough to read in one sitting; please do.
- **Host app exposure.** Port 4700 is bound to `127.0.0.1`. To watch from a
  phone, use the remote dashboard instead of opening it (next item). Port 4701 accepts only requests with a valid run token, but it
  is reachable from your LAN; it should be firewalled or bound to the
  Docker bridge address in a later change.

- **Draft MCP endpoint.** `POST /mcp` on port 4700 lets an assistant on
  your machine write draft sessions (docs/DRAFTS.md). It sits behind the
  same loopback bind, answers only loopback `Host` names and refuses
  non-loopback `Origin`s (DNS rebinding). Its tools write draft files and
  read work-target branch names and manifests; none creates, starts or
  runs a session, and a session made from a draft goes through the same
  create call and review as any other.

- **Remote dashboard (off by default).** When you turn it on and tick a
  session, that session's tickets, inbox, setup verdict, prompts and a
  short activity log go to the dashboard you configured, over HTTPS, while
  Verstas runs; tool output, file contents and diffs never do
  (docs/REMOTE.md lists both). Whoever holds the dashboard login or the
  token can run the commands in that list for ticked sessions, which
  includes approving network requests. Verstas connects out; it never
  listens for the dashboard. Untick a session, or delete the token in the
  dashboard, to stop it.

## Reviewer checklist

- [ ] `src/sandbox/docker-args.ts` produces exactly the options in the table
      above, and the unit test pins them.
- [ ] The proxy denies by default, allows `CONNECT` only to port 443 of
      listed hosts, and allows plain HTTP only to the agent API prefix.
- [ ] No host-side `git` command runs with `cwd` inside a workspace after
      cloning.
- [ ] The agent API has no route that touches sessions, Docker or other
      runs, and every route checks the run token first.
- [ ] Root inside the box (sudo, recipes, setup scripts) only ever runs
      inside the session container, and the container's flags match the
      table in Boundary 2.
- [ ] Deleting a session removes network, proxy, container and directory.
- [ ] The draft MCP tools (`src/drafts/tools.ts`) only read installation
      facts and write draft files; no tool creates, starts, runs or deletes
      anything, and `/mcp` keeps its loopback Host and Origin checks.
- [ ] `src/remote/` sends only sessions with `remote: true`, never tool
      results, and `remoteCommandSchema` has no kind that reaches settings,
      secrets, the allowlist, files, export/apply or session deletion.
