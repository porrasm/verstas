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
| `--user 1000:1000` | Non-root. There is no sudo in the image. |
| `--cap-drop ALL` | No Linux capabilities, even the defaults Docker normally keeps. |
| `--security-opt no-new-privileges` | setuid binaries cannot raise privileges. |
| `--pids-limit 2048`, `--memory <n>`, `--cpus <n>` | A runaway build or fork bomb stays inside the budget you set per session. |
| `--tmpfs /tmp:size=1g` | Scratch space that disappears with the container. |
| `-v <session>/workspace:/workspace` | The single bind mount, read-write. |
| `--env` only for `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, the Claude token and the run's board token | Nothing from your environment leaks in. |
| `--init`, `--restart no`, `--label verstas.session=<id>` | Clean signal handling, no resurrection, and cleanup can find everything by label. |

Not used, and why:

- `--privileged`, any `--device`, the Docker socket: never. These are the
  three ways out of a container.
- `--read-only` root filesystem: not in the MVP. Installs requested by the
  agent write under `/usr` and `/opt`, and the container is disposable. It
  can be added later with explicit writable mounts.
- Nested Docker (docker-in-docker, sysbox): never in the MVP. Services the
  agent needs (Postgres, Redis, a Kapula server) are installed in the image
  and run as plain processes under the agent's user.

## Boundary 3: the network

Containers on an `--internal` network cannot reach the internet, the host,
or other Docker networks. The only member besides the session container is a
**proxy container** (`node:22-alpine` running `dist/proxy/proxy.js`,
bind-mounted read-only) that is attached to both the internal network and
the default bridge, so it alone has egress.

- The session container gets `HTTPS_PROXY=http://proxy:3128` and the same
  for `HTTP_PROXY`. Tools that honour the variables (git, npm, pip, curl,
  Claude Code) work; tools that do not simply fail to connect, which is the
  desired failure mode.
- **Allowlist.** A file in the session directory, `allowlist.json`, mounted
  read-only into the proxy and re-read when it changes, so approving a
  request takes effect without a restart. Entries are `host` or
  `*.suffix`, with an optional port. HTTPS (`CONNECT`) is allowed only to
  port 443 of listed hosts. Plain HTTP is allowed only to the agent API
  (below). Everything else gets `403` and a log line.
- **Denied attempts are events.** The proxy logs `denied host:port` to
  stdout; the host app collects container logs and shows them on the
  session page. A denied host is one click from becoming a request to
  approve.
- The default allowlist for a new session: `api.anthropic.com`,
  `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`,
  `github.com`, `objects.githubusercontent.com`. Edit it per session.
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

- Every request carries a **run token**, random per run, in an
  `Authorization` header. A token grants access to one run's board, its
  notes and its request inbox, nothing else.
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
- Do not `git fetch` or `git pull` directly from `workspace/<repo>` on the
  host. The UI does not offer it and this document is why.

## Boundary 6: secrets

Two secrets enter a session, both as environment variables of the session
container:

- `CLAUDE_CODE_OAUTH_TOKEN`, made once with `claude setup-token` and stored
  in the host app's config file with mode `0600`. The agent can read it, as
  any process can read its own credentials; it can only use it against the
  one host the allowlist permits for it.
- The run's board token, scoped as described above.

Secrets requested by the agent (a third-party API key) are a later feature.
When added, they are injected the same way and the agent sees only the
variable name in its context.

## Boundary 7: installs requested by the agent

The agent user cannot install system packages. When a worker files an
install request and you approve it, the **harness** runs the install with
`docker exec -u root` using a command it assembles itself from the request's
structured fields: a package manager from a fixed set (`apt-get`, `npm -g`,
`pip`) and package names validated against a strict pattern. The agent's
free text never reaches a shell. Approved installs are recorded in
`session.json` so a rebuilt container gets them again.

## Cleanup

Everything a session creates is labelled `verstas.session=<id>`: the
network, the proxy, the session container. Deleting a session stops and
removes all three, then removes the directory. `verstas doctor` lists
labelled resources without a matching directory and offers to remove them.

## Residual risks, stated plainly

- **Allowlisted hosts are channels.** Anything on the allowlist can receive
  data the agent chooses to send. The package registries accept uploads
  from authenticated users, so never put a registry token in a session. Keep
  the list short and per session.
- **The model provider sees your code.** By your decision; it is the point.
- **Disk.** Container writes land in `workspace/` on your disk. The host
  app checks the directory size between tickets and pauses the run over a
  configurable limit; it cannot stop a single write mid-ticket.
- **Proxy correctness.** The allowlist proxy is about two hundred lines of
  TypeScript with unit tests for the matcher and the request filter. It is
  small enough to read in one sitting; please do.
- **Host app exposure.** Port 4700 is bound to `127.0.0.1`. Opening it to
  the LAN (to watch from a phone) is a later, explicit option that adds a
  password. Port 4701 accepts only requests with a valid run token, but it
  is reachable from your LAN; it should be firewalled or bound to the
  Docker bridge address in a later change.

## Reviewer checklist

- [ ] `src/sandbox/docker-args.ts` produces exactly the options in the table
      above, and the unit test pins them.
- [ ] The proxy denies by default, allows `CONNECT` only to port 443 of
      listed hosts, and allows plain HTTP only to the agent API prefix.
- [ ] No host-side `git` command runs with `cwd` inside a workspace after
      cloning.
- [ ] The agent API has no route that touches sessions, Docker or other
      runs, and every route checks the run token first.
- [ ] Install commands are built from validated fields, never from agent
      text.
- [ ] Deleting a session removes network, proxy, container and directory.
