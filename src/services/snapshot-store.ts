import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDisposableAcceptanceRuntime } from "@/lib/acceptance-runtime";

export type SnapshotStoredObject = {
  pathname: string;
  etag: string;
  size: number;
};

export type SnapshotStoredObjectSummary = SnapshotStoredObject & {
  uploadedAt: Date;
};

export interface SnapshotObjectStore {
  put(pathname: string, bytes: Uint8Array): Promise<SnapshotStoredObject>;
  get(pathname: string): Promise<Uint8Array>;
  delete(pathname: string, etag?: string | null): Promise<void>;
  list(prefix: string): Promise<SnapshotStoredObjectSummary[]>;
}

export class MemorySnapshotObjectStore implements SnapshotObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly objectMetadata = new Map<
    string,
    { etag: string; uploadedAt: Date }
  >();
  failNextPut = false;
  failNextDelete = false;
  corruptReads = false;

  async put(pathname: string, bytes: Uint8Array) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("Injected snapshot upload failure.");
    }
    if (this.objects.has(pathname)) throw new Error("Snapshot object already exists.");
    const etag = `memory-${bytes.length}-${this.objects.size + 1}`;
    this.objects.set(pathname, new Uint8Array(bytes));
    this.objectMetadata.set(pathname, { etag, uploadedAt: new Date() });
    return { pathname, etag, size: bytes.length };
  }

  async get(pathname: string) {
    const bytes = this.objects.get(pathname);
    if (!bytes) throw new Error("Snapshot object was not found.");
    const copy = new Uint8Array(bytes);
    if (this.corruptReads && copy.length) copy[copy.length - 1] ^= 1;
    return copy;
  }

  async delete(pathname: string, etag?: string | null) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("Injected snapshot deletion failure.");
    }
    const metadata = this.objectMetadata.get(pathname);
    if (metadata && etag && metadata.etag !== etag) {
      throw new Error("Snapshot object changed before deletion.");
    }
    this.objects.delete(pathname);
    this.objectMetadata.delete(pathname);
  }

  async list(prefix: string) {
    return [...this.objects.entries()]
      .filter(([pathname]) => pathname.startsWith(prefix))
      .map(([pathname, bytes]) => {
        const metadata = this.objectMetadata.get(pathname) ?? {
          etag: `memory-${bytes.length}-legacy`,
          uploadedAt: new Date(0),
        };
        return { pathname, size: bytes.length, ...metadata };
      });
  }

  seed(
    pathname: string,
    bytes: Uint8Array,
    uploadedAt: Date,
    etag = `memory-seed-${bytes.length}`
  ) {
    this.objects.set(pathname, new Uint8Array(bytes));
    this.objectMetadata.set(pathname, { etag, uploadedAt });
  }
}

class FileSnapshotObjectStore implements SnapshotObjectStore {
  constructor(private readonly root: string) {}

  private resolve(pathname: string) {
    const resolved = path.resolve(this.root, pathname);
    const root = `${path.resolve(this.root)}${path.sep}`;
    if (!resolved.startsWith(root)) throw new Error("Invalid snapshot object path.");
    return resolved;
  }

  async put(pathname: string, bytes: Uint8Array) {
    const target = this.resolve(pathname);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return { pathname, etag: `local-${bytes.length}`, size: bytes.length };
  }

  async get(pathname: string) {
    return new Uint8Array(await readFile(this.resolve(pathname)));
  }

  async delete(pathname: string) {
    await rm(this.resolve(pathname), { force: true });
  }

  async list(prefix: string) {
    const start = this.resolve(prefix);
    const objects: SnapshotStoredObjectSummary[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const item of entries) {
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) {
          await walk(absolute);
        } else if (item.isFile()) {
          const details = await stat(absolute);
          const pathname = path.relative(this.root, absolute).split(path.sep).join("/");
          objects.push({
            pathname,
            etag: `local-${details.size}-${details.mtimeMs}`,
            size: details.size,
            uploadedAt: details.mtime,
          });
        }
      }
    };
    await walk(start);
    return objects;
  }
}

class VercelBlobSnapshotObjectStore implements SnapshotObjectStore {
  async put(pathname: string, bytes: Uint8Array) {
    const { put } = await import("@vercel/blob");
    const result = await put(pathname, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "application/octet-stream",
    });
    return {
      pathname: result.pathname,
      etag: result.etag,
      size: bytes.length,
    };
  }

  async get(pathname: string) {
    const { get } = await import("@vercel/blob");
    const result = await get(pathname, {
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200) {
      throw new Error("Snapshot object was not found.");
    }
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  async delete(pathname: string, etag?: string | null) {
    const { BlobNotFoundError, del } = await import("@vercel/blob");
    try {
      await del(pathname, etag ? { ifMatch: etag } : undefined);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return;
      throw error;
    }
  }

  async list(prefix: string) {
    const { list } = await import("@vercel/blob");
    const objects: SnapshotStoredObjectSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      objects.push(
        ...page.blobs.map((blob) => ({
          pathname: blob.pathname,
          etag: blob.etag,
          size: blob.size,
          uploadedAt: blob.uploadedAt,
        }))
      );
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }
}

let defaultStore: SnapshotObjectStore | null = null;

export function getSnapshotObjectStore(): SnapshotObjectStore {
  if (defaultStore) return defaultStore;
  const localDir = process.env.SNAPSHOT_LOCAL_DIR?.trim();
  if (
    localDir &&
    (process.env.NODE_ENV !== "production" || isDisposableAcceptanceRuntime())
  ) {
    defaultStore = new FileSnapshotObjectStore(localDir);
    return defaultStore;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Private snapshot storage is not configured.");
  }
  defaultStore = new VercelBlobSnapshotObjectStore();
  return defaultStore;
}
