// trust-app/scripts/move-dir.mjs
//
// Cross-device-safe directory move helper used by select-target.mjs
// and restore-targets.mjs.
//
// Why this exists:
//   POSIX rename(2) returns EXDEV when source and destination live
//   on different filesystems. In a Docker `RUN` step, files COPY'd
//   from an earlier layer can sit on a different overlay layer than
//   the working layer, and Linux refuses to rename across that
//   boundary. Node's fs.renameSync surfaces the same EXDEV error.
//
//   On the host (single filesystem) this never fires. We keep the
//   fast renameSync path and only fall back to a recursive copy +
//   remove when EXDEV bubbles up — atomic where possible, portable
//   everywhere.

import { cpSync, renameSync, rmSync } from "node:fs";

/**
 * Move a directory from `src` to `dest`, preserving metadata. Uses
 * atomic rename when source and destination share a filesystem,
 * otherwise falls back to recursive copy + remove.
 *
 * Throws on any error other than EXDEV from the initial rename.
 *
 * @param {string} src  Absolute source path (must exist).
 * @param {string} dest Absolute destination path (must NOT exist).
 */
export function moveDir(src, dest) {
  try {
    renameSync(src, dest);
    return;
  } catch (err) {
    if (!err || err.code !== "EXDEV") {
      throw err;
    }
  }

  // Cross-device fallback: recursive copy followed by removal of
  // the original. preserveTimestamps keeps mtime stable so any
  // downstream caching (Next.js, tsbuildinfo) isn't invalidated by
  // the move alone.
  cpSync(src, dest, { recursive: true, preserveTimestamps: true });
  rmSync(src, { recursive: true, force: true });
}
