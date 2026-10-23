// RepBook's single-project replacement for Next.js 16.4.2 root discovery.
// Deliberately supports literal directories only. No glob parser is loaded.
"use strict";
const { statSync } = require("node:fs");
const { resolve } = require("node:path");

function literalRoot(rootDir) {
    if (rootDir.length === 0 || /[!*?{}\[\]()]/.test(rootDir)) {
        throw new Error("RepBook lint roots must be non-empty literal directories; glob rootDir settings require a separately reviewed implementation.");
    }
    const normalized = rootDir.replace(/\\/g, "/");
    try {
        return statSync(resolve(normalized)).isDirectory() ? [normalized] : [];
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
        throw error;
    }
}

function getRootDirs(context) {
    const rootDir = (context.settings.next || {}).rootDir;
    if (typeof rootDir === "string") return literalRoot(rootDir);
    if (Array.isArray(rootDir)) {
        return rootDir.flatMap((dir) => typeof dir === "string" ? literalRoot(dir) : []);
    }
    return [context.cwd];
}

exports.getRootDirs = getRootDirs;
