import { promises as fs } from "fs";
import path from "path";
import { boardSchema, type Board } from "../core/types.js";
import { emptyBoard } from "./board.js";

/**
 * File-backed board: `<session>/board.json`. Writes go to a temp file and
 * are renamed into place, so a crash mid-write leaves the previous board
 * intact. The host app is the only writer; the agent goes through the API.
 */
export const boardPath = (sessionDir: string): string => path.join(sessionDir, "board.json");

export const loadBoard = async (sessionDir: string): Promise<Board> => {
  try {
    const raw = await fs.readFile(boardPath(sessionDir), "utf8");
    return boardSchema.parse(JSON.parse(raw));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyBoard();
    throw e;
  }
};

export const saveBoard = async (sessionDir: string, board: Board): Promise<void> => {
  await writeJsonAtomic(boardPath(sessionDir), boardSchema.parse(board));
};

export const writeJsonAtomic = async (file: string, value: unknown): Promise<void> => {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
};
