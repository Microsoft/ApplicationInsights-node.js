"use strict";

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import Logging = require("../../Library/Logging")

export const homedir = os.homedir ? os.homedir() : (process.env[(process.platform == "win32") ? "USERPROFILE" : "HOME"]);

/**
 * Zero dependencies: recursive mkdir
 */
function mkDirByPathSync(HOME_DIR: string, targetDir: string, { isRelativeToScript = false } = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : "";
    const baseDir = isRelativeToScript ? __dirname : ".";

    return targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            // Don't try to recreate homedir
            if (HOME_DIR.indexOf(curDir) === -1) {
                fs.mkdirSync(curDir);
            }
        } catch (err) {
            if (err.code === "EEXIST") { // curDir already exists!
                return curDir;
            }

            // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
            if (err.code === "ENOENT") { // Throw the original parentDir error on curDir `ENOENT` failure.
                throw new Error(`EACCES: permission denied, mkdir "${parentDir}"`);
            }

            const caughtErr = ["EACCES", "EPERM", "EISDIR"].indexOf(err.code) > -1;
            if (!caughtErr || caughtErr && curDir === path.resolve(targetDir)) {
                throw err; // Throw if it's just the last created dir.
            }
        }
        return curDir;

    }, initDir);
}

export function makeStatusDirs(filepath: string): boolean {
    try {
        mkDirByPathSync(homedir, filepath.replace(/\\/g, path.sep).replace(/\//g, path.sep));
        return true;
    } catch (e) {
        Logging.error("Error creating Application Insights status folder", e);
        return false;
    }
}



export function renameCurrentFile(filepath: string, filename: string, callback?: (err: Error | null, destfullpath?: string) => void): void {
    const fullpath = path.join(filepath, filename);
    const basename = path.basename(filename, path.extname(filename));
    const stats = fs.stat(fullpath, (statsErr, stats) => {
        if (statsErr) {
            return callback(statsErr);
        }

        const createDate = new Date(stats.birthtime);
        const destfilename = basename + "-" +
            createDate.toISOString().replace(/[T:\.]/g, "_").replace("Z", "") +
            path.extname(filename) + ".old";
        const destfullpath = path.join(filepath, destfilename);
        fs.rename(fullpath, destfullpath, (renameErr) => {
            if (typeof callback === "function") {
                callback(renameErr, destfullpath);
            }
        });
    });
}
