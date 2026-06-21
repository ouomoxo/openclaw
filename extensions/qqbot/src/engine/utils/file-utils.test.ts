// Qqbot tests cover file utils plugin behavior.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  fetchMedia: vi.fn(),
}));

vi.mock("../adapter/index.js", () => ({
  getPlatformAdapter: () => ({
    fetchMedia: (...args: unknown[]) => adapterMocks.fetchMedia(...args),
  }),
}));

import {
  QQBOT_MEDIA_SSRF_POLICY,
  checkFileSize,
  downloadFile,
  fileExistsAsync,
  getImageMimeType,
  getMimeType,
  readFileAsync,
} from "./file-utils.js";

describe("qqbot file-utils MIME helpers", () => {
  it("uses the shared media MIME table for extension inference", () => {
    expect(getMimeType("voice.mp3")).toBe("audio/mpeg");
    expect(getMimeType("clip.webm")).toBe("video/webm");
    expect(getMimeType("clip.avi")).toBe("video/x-msvideo");
    expect(getMimeType("clip.mkv")).toBe("video/x-matroska");
    expect(getMimeType("archive.unknown")).toBe("application/octet-stream");
  });

  it("keeps the image-only gate for image MIME inference", () => {
    expect(getImageMimeType("photo.PNG")).toBe("image/png");
    expect(getImageMimeType("clip.webm")).toBeNull();
    expect(getImageMimeType("archive.unknown")).toBeNull();
  });
});

async function canCreateFileSymlink(dir: string): Promise<boolean> {
  const targetPath = path.join(dir, "symlink-probe-target.txt");
  const linkPath = path.join(dir, "symlink-probe-link.txt");
  try {
    await fs.promises.writeFile(targetPath, "probe");
    await fs.promises.symlink(targetPath, linkPath, "file");
    return true;
  } catch {
    return false;
  } finally {
    await fs.promises.rm(linkPath, { force: true });
    await fs.promises.rm(targetPath, { force: true });
  }
}

describe("qqbot file-utils downloadFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    adapterMocks.fetchMedia.mockReset();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qqbot-file-utils-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("downloads through the guarded media adapter with the qqbot SSRF policy", async () => {
    adapterMocks.fetchMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "remote.png",
    });

    const savedPath = await downloadFile(
      "https://media.qq.com/assets/photo.png",
      tempDir,
      "photo.png",
    );

    if (!savedPath) {
      throw new Error("expected QQBot media file path");
    }
    expect(savedPath).toMatch(/photo_\d+_[0-9a-f]{6}\.png$/);
    expect(await fs.promises.readFile(savedPath, "utf8")).toBe("image-bytes");
    expect(adapterMocks.fetchMedia).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      ssrfPolicy: QQBOT_MEDIA_SSRF_POLICY,
    });
    expect(QQBOT_MEDIA_SSRF_POLICY).toEqual({
      hostnameAllowlist: [
        "*.qpic.cn",
        "*.qq.com",
        "*.weiyun.com",
        "*.qq.com.cn",
        "*.ugcimg.cn",
        "*.myqcloud.com",
        "*.tencentcos.cn",
        "*.tencentcos.com",
      ],
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("rejects non-HTTPS URLs before attempting a fetch", async () => {
    const savedPath = await downloadFile("http://media.qq.com/assets/photo.png", tempDir);

    expect(savedPath).toBeNull();
    expect(adapterMocks.fetchMedia).not.toHaveBeenCalled();
  });

  // Keep the local skipIf shape while probing inside the test, avoiding
  // import-time filesystem side effects on hosts that cannot create links.
  it.skipIf(false)("rejects symlinked local media helpers", async ({ skip }) => {
    if (!(await canCreateFileSymlink(tempDir))) {
      skip("file symlinks are unavailable on this host");
    }

    const targetPath = path.join(tempDir, "target.png");
    const linkPath = path.join(tempDir, "link.png");
    await fs.promises.writeFile(targetPath, "image-bytes");
    await fs.promises.symlink(targetPath, linkPath, "file");

    expect(checkFileSize(linkPath).ok).toBe(false);
    await expect(readFileAsync(linkPath)).rejects.toThrow(/symbolic link|symlink|regular file/i);
    await expect(fileExistsAsync(linkPath)).resolves.toBe(false);
  });
});
