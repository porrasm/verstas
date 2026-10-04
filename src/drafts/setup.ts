/**
 * "Connect an assistant": how to point an MCP client at the draft server,
 * with this installation's real port and paths filled in. Shown with copy
 * buttons on the New session page and the drafts list.
 */

export type McpSetupInput = {
  /** The MCP endpoint, e.g. http://127.0.0.1:4700/mcp. */
  url: string;
  /** Absolute path of dist/src/drafts/mcp-stdio.js. */
  stdioScript: string;
  /** Whether that file exists (npm run build / npm run setup made it). */
  stdioBuilt: boolean;
  /** The Node binary to run it with; under Electron, Electron in Node mode. */
  node: { command: string; electron: boolean };
};

export type McpSetup = {
  url: string;
  /** For Claude Code: one command, available in every project (user scope). */
  claudeCode: string;
  /** For Claude Desktop and other stdio clients: the mcpServers entry. */
  desktopConfig: string;
  stdioBuilt: boolean;
  /** A first message for the assistant once it is connected. */
  prompt: string;
};

export const MCP_SERVER_NAME = "verstas";

export const mcpSetup = (i: McpSetupInput): McpSetup => {
  const entry: Record<string, unknown> = { command: i.node.command, args: [i.stdioScript] };
  if (i.node.electron) entry.env = { ELECTRON_RUN_AS_NODE: "1" };
  return {
    url: i.url,
    claudeCode: `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${i.url}`,
    desktopConfig: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2),
    stdioBuilt: i.stdioBuilt,
    prompt: [
      `Use the ${MCP_SERVER_NAME} MCP server to prepare a Verstas draft session for what we discussed.`,
      "Call verstas_context first. Then create the draft and build it step by step: repositories, session requirements, network packs, recipes, and the board a few tickets at a time.",
      "Run draft_validate until there are no errors, put your assumptions in the notes, and give me the review link. Do not try to create or start the session; I do that in Verstas.",
    ].join(" "),
  };
};
