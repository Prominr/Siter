const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 8000;
const ROOT_DIR = __dirname;
const INDEX_PATH = path.join(ROOT_DIR, "index.html");
const DEPLOYMENTS_DIR = path.join(ROOT_DIR, ".deployments");
const MAX_DEPLOYMENT_PAYLOAD_BYTES = Number(process.env.MAX_DEPLOYMENT_PAYLOAD_BYTES) || (15 * 1024 * 1024);
const MAX_DEPLOYMENT_FILE_COUNT = Number(process.env.MAX_DEPLOYMENT_FILE_COUNT) || 350;
const DEFAULT_PROXY_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm"
};

const BLOCKED_PROXY_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "set-cookie",
  "set-cookie2"
]);

const SKIP_PROXY_SCHEMES = /^(?:#|data:|blob:|javascript:|mailto:|tel:)/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/=\r\n]*$/;
const DEPLOYMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function decodePathname(requestUrl) {
  try {
    return decodeURIComponent(requestUrl.pathname);
  } catch (_error) {
    return requestUrl.pathname;
  }
}

function isSafePathInside(basePath, targetPath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);

  if (process.platform === "win32") {
    const base = resolvedBase.toLowerCase();
    const target = resolvedTarget.toLowerCase();
    return target === base || target.startsWith(`${base}${path.sep}`);
  }

  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(response, allowHeader) {
  response.writeHead(405, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Allow: allowHeader
  });
  response.end(JSON.stringify({
    error: "Method not allowed."
  }));
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeDeploymentName(rawName) {
  const cleaned = String(rawName || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleaned) {
    return "Untitled Site";
  }

  return cleaned.slice(0, 80);
}

function toProjectSlug(rawName) {
  const slug = String(rawName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "site";
}

function makeDeploymentId(projectName) {
  const stamp = Date.now().toString(36);
  return `${toProjectSlug(projectName)}-${stamp}`;
}

function normalizeDeploymentRelativePath(rawPath) {
  const normalizedSlashes = String(rawPath || "")
    .replace(/\\+/g, "/")
    .trim();

  if (!normalizedSlashes) {
    return "";
  }

  const withoutLeadingSlash = normalizedSlashes.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);

  if (!normalized || normalized === ".") {
    return "";
  }

  if (normalized.startsWith("../") || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    return "";
  }

  return normalized;
}

function buildDeploymentSupportFiles(projectName) {
  const displayName = normalizeDeploymentName(projectName);
  const slug = toProjectSlug(displayName);

  const generatedPackageJson = {
    name: `${slug}-site`,
    version: "1.0.0",
    private: true,
    scripts: {
      start: "node server.js"
    },
    engines: {
      node: ">=18"
    }
  };

  const generatedStaticServer = [
    "const http = require(\"node:http\");",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "",
    "const HOST = \"0.0.0.0\";",
    "const PORT = Number(process.env.PORT) || 8000;",
    "const ROOT_DIR = __dirname;",
    "const INDEX_PATH = path.join(ROOT_DIR, \"index.html\");",
    "",
    "const MIME_TYPES = {",
    "  \".html\": \"text/html; charset=utf-8\",",
    "  \".js\": \"application/javascript; charset=utf-8\",",
    "  \".css\": \"text/css; charset=utf-8\",",
    "  \".json\": \"application/json; charset=utf-8\",",
    "  \".txt\": \"text/plain; charset=utf-8\",",
    "  \".svg\": \"image/svg+xml\",",
    "  \".png\": \"image/png\",",
    "  \".jpg\": \"image/jpeg\",",
    "  \".jpeg\": \"image/jpeg\",",
    "  \".gif\": \"image/gif\",",
    "  \".ico\": \"image/x-icon\",",
    "  \".webp\": \"image/webp\"",
    "};",
    "",
    "function sendFile(response, filePath) {",
    "  const extension = path.extname(filePath).toLowerCase();",
    "  const contentType = MIME_TYPES[extension] || \"application/octet-stream\";",
    "",
    "  fs.readFile(filePath, (error, fileData) => {",
    "    if (error) {",
    "      response.writeHead(404, {",
    "        \"Content-Type\": \"text/plain; charset=utf-8\",",
    "        \"Cache-Control\": \"no-store\"",
    "      });",
    "      response.end(\"Not found\");",
    "      return;",
    "    }",
    "",
    "    response.writeHead(200, {",
    "      \"Content-Type\": contentType,",
    "      \"Cache-Control\": \"no-store\"",
    "    });",
    "    response.end(fileData);",
    "  });",
    "}",
    "",
    "const server = http.createServer((request, response) => {",
    "  if (request.method !== \"GET\" && request.method !== \"HEAD\") {",
    "    response.writeHead(405, {",
    "      \"Content-Type\": \"text/plain; charset=utf-8\",",
    "      Allow: \"GET, HEAD\"",
    "    });",
    "    response.end(\"Method not allowed\");",
    "    return;",
    "  }",
    "",
    "  const requestUrl = new URL(request.url || \"/\", \"http://localhost\");",
    "  let pathname;",
    "  try {",
    "    pathname = decodeURIComponent(requestUrl.pathname);",
    "  } catch (_error) {",
    "    pathname = requestUrl.pathname;",
    "  }",
    "",
    "  const relativePath = pathname === \"/\" ? \"index.html\" : pathname.replace(/^\\/+/g, \"\");",
    "  const filePath = path.resolve(ROOT_DIR, relativePath);",
    "",
    "  if (!filePath.toLowerCase().startsWith(ROOT_DIR.toLowerCase())) {",
    "    sendFile(response, INDEX_PATH);",
    "    return;",
    "  }",
    "",
    "  fs.stat(filePath, (error, stats) => {",
    "    if (error || !stats.isFile()) {",
    "      sendFile(response, INDEX_PATH);",
    "      return;",
    "    }",
    "",
    "    if (request.method === \"HEAD\") {",
    "      const extension = path.extname(filePath).toLowerCase();",
    "      response.writeHead(200, {",
    "        \"Content-Type\": MIME_TYPES[extension] || \"application/octet-stream\",",
    "        \"Cache-Control\": \"no-store\"",
    "      });",
    "      response.end();",
    "      return;",
    "    }",
    "",
    "    sendFile(response, filePath);",
    "  });",
    "});",
    "",
    "server.listen(PORT, HOST, () => {",
    "  console.log(`Static server running at http://${HOST}:${PORT}`);",
    "});"
  ].join("\n");

  const deploymentGuide = [
    "# Deployment Guide",
    "",
    `Project: ${displayName}`,
    "",
    "## Railway",
    "1. Push this folder to GitHub.",
    "2. In Railway, choose Deploy from GitHub.",
    "3. Set Root Directory to this project folder.",
    "4. Deploy. Railway uses npm start.",
    "",
    "## Koyeb",
    "1. Push this folder to GitHub.",
    "2. In Koyeb, create a Web Service from the repository.",
    "3. Use Dockerfile builder (Dockerfile included).",
    "4. Deploy on port 8000 (PORT env is already supported)."
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(generatedPackageJson, null, 2)}\n`,
    "server.js": `${generatedStaticServer}\n`,
    "railway.json": `${JSON.stringify({
      "$schema": "https://railway.app/railway.schema.json",
      build: {
        builder: "NIXPACKS"
      },
      deploy: {
        startCommand: "npm start",
        healthcheckPath: "/",
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 10
      }
    }, null, 2)}\n`,
    "Dockerfile": "FROM node:20-alpine\n\nWORKDIR /app\n\nCOPY package*.json ./\nRUN npm install --omit=dev\n\nCOPY . .\n\nENV NODE_ENV=production\nENV PORT=8000\nEXPOSE 8000\n\nCMD [\"npm\", \"start\"]\n",
    ".dockerignore": "node_modules\nnpm-debug.log\n.git\n.gitignore\n",
    "DEPLOYMENT_NOTES.md": `${deploymentGuide}\n`
  };
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function safeReject(error) {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    }

    function safeResolve(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        safeReject(createHttpError(413, "Request body too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      if (settled) {
        return;
      }

      try {
        const rawText = Buffer.concat(chunks).toString("utf8");
        const payload = rawText ? JSON.parse(rawText) : {};
        safeResolve(payload);
      } catch (_error) {
        safeReject(createHttpError(400, "Invalid JSON request body."));
      }
    });

    request.on("error", (error) => {
      safeReject(error);
    });
  });
}

function getRequestOrigin(request) {
  const forwardedProtoHeader = String(request.headers["x-forwarded-proto"] || "");
  const forwardedHostHeader = String(request.headers["x-forwarded-host"] || "");

  const protocol = forwardedProtoHeader
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || "http";

  const host = forwardedHostHeader
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || request.headers.host || `localhost:${PORT}`;

  return `${protocol}://${host}`;
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function encodeHtml(rawValue) {
  return String(rawValue || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeBase64Payload(rawValue) {
  const compact = String(rawValue || "").replace(/\s+/g, "");
  if (!compact) {
    return Buffer.alloc(0);
  }

  if (!BASE64_PATTERN.test(compact)) {
    throw createHttpError(400, "Invalid base64 file payload.");
  }

  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  const buffer = Buffer.from(padded, "base64");
  const inputComparable = padded.replace(/=+$/, "");
  const outputComparable = buffer.toString("base64").replace(/=+$/, "");

  if (inputComparable !== outputComparable) {
    throw createHttpError(400, "Invalid base64 file payload.");
  }

  return buffer;
}

function normalizeDeploymentFiles(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw createHttpError(400, "Deployment requires at least one file.");
  }

  if (rawFiles.length > MAX_DEPLOYMENT_FILE_COUNT) {
    throw createHttpError(400, `Too many files. Limit is ${MAX_DEPLOYMENT_FILE_COUNT}.`);
  }

  const normalizedFiles = new Map();
  const seenPaths = new Set();
  let totalBytes = 0;

  for (const entry of rawFiles) {
    if (!entry || typeof entry !== "object") {
      throw createHttpError(400, "Each file entry must be an object.");
    }

    const normalizedPath = normalizeDeploymentRelativePath(entry.path);
    if (!normalizedPath) {
      throw createHttpError(400, "One or more file paths are invalid.");
    }

    const pathKey = normalizedPath.toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw createHttpError(400, `Duplicate file path detected: ${normalizedPath}`);
    }

    if (typeof entry.contentBase64 !== "string") {
      throw createHttpError(400, `Missing content for file: ${normalizedPath}`);
    }

    const fileBuffer = decodeBase64Payload(entry.contentBase64);
    totalBytes += fileBuffer.length;
    if (totalBytes > MAX_DEPLOYMENT_PAYLOAD_BYTES) {
      throw createHttpError(413, "Deployment payload exceeds the configured size limit.");
    }

    seenPaths.add(pathKey);
    normalizedFiles.set(normalizedPath, fileBuffer);
  }

  return normalizedFiles;
}

function buildGeneratedIndex(projectName, filePaths) {
  const links = filePaths
    .filter((filePath) => /\.html?$/i.test(filePath))
    .slice(0, 60)
    .map((filePath) => `<li><a href="./${encodeHtml(filePath)}">${encodeHtml(filePath)}</a></li>`)
    .join("\n");

  const listBlock = links || "<li>No HTML files found in upload.</li>";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${encodeHtml(projectName)}</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 24px;
    }
    main {
      max-width: 780px;
      margin: 0 auto;
      background: #111827;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 20px;
    }
    h1 {
      margin-top: 0;
    }
    a {
      color: #38bdf8;
    }
    li {
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${encodeHtml(projectName)}</h1>
    <p>An index.html file was not uploaded, so this landing page was generated automatically.</p>
    <ul>${listBlock}</ul>
  </main>
</body>
</html>`;
}

function deploymentPathExists(fileMap, fileName) {
  const expected = String(fileName).toLowerCase();
  for (const existingPath of fileMap.keys()) {
    if (existingPath.toLowerCase() === expected) {
      return true;
    }
  }
  return false;
}

async function ensureDeploymentsDirectory() {
  await fsp.mkdir(DEPLOYMENTS_DIR, {
    recursive: true
  });
}

async function createDeploymentWorkspace(projectName) {
  const slug = toProjectSlug(projectName);
  const attempts = 20;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const suffix = `${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
    const deploymentId = `${slug}-${suffix}`;
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
      continue;
    }

    const deploymentRoot = path.join(DEPLOYMENTS_DIR, deploymentId);
    try {
      await fsp.mkdir(deploymentRoot);
      return {
        deploymentId,
        deploymentRoot,
        siteRoot: path.join(deploymentRoot, "site")
      };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw createHttpError(500, "Unable to create deployment workspace. Please retry.");
}

async function writeDeploymentSiteFiles(siteRoot, fileMap) {
  await fsp.mkdir(siteRoot, {
    recursive: true
  });

  for (const [relativePath, fileBuffer] of fileMap.entries()) {
    const absolutePath = path.join(siteRoot, ...relativePath.split("/"));
    if (!isSafePathInside(siteRoot, absolutePath)) {
      throw createHttpError(400, `Illegal file path rejected: ${relativePath}`);
    }

    await fsp.mkdir(path.dirname(absolutePath), {
      recursive: true
    });
    await fsp.writeFile(absolutePath, fileBuffer);
  }
}

function toDeploymentSummary(meta, origin) {
  const deploymentPath = `/deployments/${meta.id}/`;
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    fileCount: meta.fileCount,
    generatedSupportFiles: meta.generatedSupportFiles || [],
    localPath: deploymentPath,
    localUrl: `${origin}${deploymentPath}`,
    targets: {
      railway: true,
      koyeb: true
    }
  };
}

async function readDeploymentMeta(deploymentId) {
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw createHttpError(404, "Deployment not found.");
  }

  const deploymentRoot = path.join(DEPLOYMENTS_DIR, deploymentId);
  const metaPath = path.join(deploymentRoot, "meta.json");

  let rawMeta;
  try {
    rawMeta = await fsp.readFile(metaPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw createHttpError(404, "Deployment not found.");
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawMeta);
  } catch (_error) {
    throw createHttpError(500, "Deployment metadata is corrupted.");
  }

  return {
    id: deploymentId,
    name: normalizeDeploymentName(parsed.name),
    createdAt: parsed.createdAt || new Date().toISOString(),
    updatedAt: parsed.updatedAt || parsed.createdAt || new Date().toISOString(),
    fileCount: Number(parsed.fileCount) || 0,
    generatedSupportFiles: Array.isArray(parsed.generatedSupportFiles) ? parsed.generatedSupportFiles : []
  };
}

async function listDeploymentMetadata() {
  await ensureDeploymentsDirectory();

  let entries = [];
  try {
    entries = await fsp.readdir(DEPLOYMENTS_DIR, {
      withFileTypes: true
    });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const metadata = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!DEPLOYMENT_ID_PATTERN.test(entry.name)) {
      continue;
    }

    try {
      const meta = await readDeploymentMeta(entry.name);
      metadata.push(meta);
    } catch (_error) {
      // Skip malformed deployment entries to keep listing resilient.
    }
  }

  metadata.sort((a, b) => {
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  return metadata;
}

function parseDeploymentAssetPath(pathname) {
  const match = pathname.match(/^\/deployments\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(.*))?$/i);
  if (!match) {
    return null;
  }

  const deploymentId = match[1].toLowerCase();
  const rawRelativePath = match[2] || "";
  const normalizedRelativePath = normalizeDeploymentRelativePath(rawRelativePath || "index.html") || "index.html";

  return {
    deploymentId,
    rawRelativePath,
    normalizedRelativePath
  };
}

function sendFileHeadOnly(response, filePath, statusCode = 200) {
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  response.end();
}

async function handleCreateDeploymentRequest(request, response) {
  const payload = await readJsonBody(request, MAX_DEPLOYMENT_PAYLOAD_BYTES);
  const projectName = normalizeDeploymentName(payload && payload.name);
  const includeSupportFiles = payload && payload.includeSupportFiles !== false;
  const normalizedFiles = normalizeDeploymentFiles(payload && payload.files);

  if (!deploymentPathExists(normalizedFiles, "index.html")) {
    const generatedIndex = buildGeneratedIndex(projectName, Array.from(normalizedFiles.keys()));
    normalizedFiles.set("index.html", Buffer.from(generatedIndex, "utf8"));
  }

  const generatedSupportFiles = [];
  if (includeSupportFiles) {
    const supportFiles = buildDeploymentSupportFiles(projectName);
    for (const [supportPath, supportContent] of Object.entries(supportFiles)) {
      if (deploymentPathExists(normalizedFiles, supportPath)) {
        continue;
      }

      normalizedFiles.set(supportPath, Buffer.from(supportContent, "utf8"));
      generatedSupportFiles.push(supportPath);
    }
  }

  await ensureDeploymentsDirectory();
  const workspace = await createDeploymentWorkspace(projectName);

  try {
    await writeDeploymentSiteFiles(workspace.siteRoot, normalizedFiles);
  } catch (error) {
    await fsp.rm(workspace.deploymentRoot, {
      recursive: true,
      force: true
    });
    throw error;
  }

  const timestamp = new Date().toISOString();
  const metadata = {
    id: workspace.deploymentId,
    name: projectName,
    createdAt: timestamp,
    updatedAt: timestamp,
    fileCount: normalizedFiles.size,
    generatedSupportFiles
  };

  await fsp.writeFile(
    path.join(workspace.deploymentRoot, "meta.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );

  const origin = getRequestOrigin(request);
  sendJson(response, 201, {
    deployment: toDeploymentSummary(metadata, origin),
    limits: {
      maxPayloadBytes: MAX_DEPLOYMENT_PAYLOAD_BYTES,
      maxFileCount: MAX_DEPLOYMENT_FILE_COUNT
    }
  });
}

async function handleListDeploymentsRequest(request, response) {
  const origin = getRequestOrigin(request);
  const metadata = await listDeploymentMetadata();
  const deployments = metadata.map((entry) => toDeploymentSummary(entry, origin));

  sendJson(response, 200, {
    deployments,
    limits: {
      maxPayloadBytes: MAX_DEPLOYMENT_PAYLOAD_BYTES,
      maxFileCount: MAX_DEPLOYMENT_FILE_COUNT
    }
  });
}

async function handleGetDeploymentRequest(request, response, deploymentId) {
  const origin = getRequestOrigin(request);
  const metadata = await readDeploymentMeta(deploymentId);

  sendJson(response, 200, {
    deployment: toDeploymentSummary(metadata, origin)
  });
}

async function handleApiRequest(request, response, pathname) {
  if (pathname === "/api/health") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, "GET");
      return;
    }

    sendJson(response, 200, {
      status: "ok",
      service: "Siting Deploy Studio"
    });
    return;
  }

  if (pathname === "/api/deployments") {
    if (request.method === "GET") {
      await handleListDeploymentsRequest(request, response);
      return;
    }

    if (request.method === "POST") {
      await handleCreateDeploymentRequest(request, response);
      return;
    }

    sendMethodNotAllowed(response, "GET, POST");
    return;
  }

  const deploymentMatch = pathname.match(/^\/api\/deployments\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (deploymentMatch) {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, "GET");
      return;
    }

    await handleGetDeploymentRequest(request, response, deploymentMatch[1].toLowerCase());
    return;
  }

  sendJson(response, 404, {
    error: "API route not found."
  });
}

async function handleDeploymentAssetRequest(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendMethodNotAllowed(response, "GET, HEAD");
    return;
  }

  const routeData = parseDeploymentAssetPath(pathname);
  if (!routeData) {
    sendText(response, 404, "Deployment not found.");
    return;
  }

  const siteRoot = path.join(DEPLOYMENTS_DIR, routeData.deploymentId, "site");
  let relativePath = routeData.normalizedRelativePath;
  let filePath = path.join(siteRoot, ...relativePath.split("/"));

  if (!isSafePathInside(siteRoot, filePath)) {
    sendText(response, 404, "Deployment file not found.");
    return;
  }

  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      throw createHttpError(404, "Deployment file not found.");
    }
  } catch (error) {
    const isNotFound = error && (error.code === "ENOENT" || error.statusCode === 404);
    if (!isNotFound) {
      throw error;
    }

    if (!path.posix.extname(relativePath)) {
      relativePath = "index.html";
      filePath = path.join(siteRoot, relativePath);
      if (!isSafePathInside(siteRoot, filePath)) {
        sendText(response, 404, "Deployment file not found.");
        return;
      }

      try {
        const indexStats = await fsp.stat(filePath);
        if (!indexStats.isFile()) {
          sendText(response, 404, "Deployment file not found.");
          return;
        }
      } catch (_indexError) {
        sendText(response, 404, "Deployment file not found.");
        return;
      }
    } else {
      sendText(response, 404, "Deployment file not found.");
      return;
    }
  }

  if (request.method === "HEAD") {
    sendFileHeadOnly(response, filePath);
    return;
  }

  sendFile(response, filePath);
}

async function handleMainStaticRequest(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD"
    });
    response.end("Method not allowed");
    return;
  }

  let filePath;
  if (pathname === "/") {
    filePath = INDEX_PATH;
  } else {
    const safePath = path.normalize(pathname).replace(/^([/\\])+/g, "");
    if (!safePath || safePath === "." || safePath === ".." || safePath.startsWith(`.deployments${path.sep}`) || safePath === ".deployments") {
      sendFile(response, INDEX_PATH);
      return;
    }

    filePath = path.resolve(ROOT_DIR, safePath);
    if (!isSafePathInside(ROOT_DIR, filePath)) {
      sendFile(response, INDEX_PATH);
      return;
    }

    if (!path.extname(filePath)) {
      filePath = INDEX_PATH;
    }
  }

  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch (_error) {
    sendFile(response, INDEX_PATH);
    return;
  }

  if (!stats.isFile()) {
    sendFile(response, INDEX_PATH);
    return;
  }

  if (request.method === "HEAD") {
    sendFileHeadOnly(response, filePath);
    return;
  }

  sendFile(response, filePath);
}

function isHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function toProxyUrl(targetUrl) {
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function toAbsoluteUrl(rawValue, baseUrl) {
  const value = String(rawValue || "").trim();
  if (!value || SKIP_PROXY_SCHEMES.test(value) || value.startsWith("/proxy?url=")) {
    return "";
  }

  try {
    if (value.startsWith("//")) {
      const protocol = new URL(baseUrl).protocol;
      return `${protocol}${value}`;
    }

    return new URL(value, baseUrl).toString();
  } catch (_error) {
    return "";
  }
}

function rewriteSrcsetValue(rawSrcset, baseUrl) {
  return String(rawSrcset)
    .split(",")
    .map((candidate) => {
      const chunk = candidate.trim();
      if (!chunk) {
        return "";
      }

      const parts = chunk.split(/\s+/);
      const source = parts[0];
      const absolute = toAbsoluteUrl(source, baseUrl);
      if (!absolute) {
        return chunk;
      }

      parts[0] = toProxyUrl(absolute);
      return parts.join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function rewriteCssUrls(cssText, baseUrl) {
  let rewritten = String(cssText || "");

  rewritten = rewritten.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (fullMatch, _quote, rawValue) => {
    const absolute = toAbsoluteUrl(rawValue, baseUrl);
    if (!absolute) {
      return fullMatch;
    }
    return `url("${toProxyUrl(absolute)}")`;
  });

  rewritten = rewritten.replace(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi, (fullMatch, quote, rawValue) => {
    const absolute = toAbsoluteUrl(rawValue, baseUrl);
    if (!absolute) {
      return fullMatch;
    }
    return `@import ${quote}${toProxyUrl(absolute)}${quote}`;
  });

  return rewritten;
}

function rewriteHtmlDocument(html, baseUrl) {
  let rewritten = String(html || "");

  rewritten = rewritten.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, "");
  rewritten = rewritten.replace(/<meta[^>]+http-equiv=["']x-frame-options["'][^>]*>/gi, "");
  rewritten = rewritten.replace(/<base\b[^>]*>/gi, "");

  rewritten = rewritten.replace(/\b(src|href|action|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (fullMatch, attr, wrappedValue, dqValue, sqValue, bareValue) => {
    const rawValue = dqValue ?? sqValue ?? bareValue ?? "";
    const absolute = toAbsoluteUrl(rawValue, baseUrl);
    if (!absolute) {
      return fullMatch;
    }

    const proxied = toProxyUrl(absolute);
    if (wrappedValue.startsWith("\"") && wrappedValue.endsWith("\"")) {
      return `${attr}="${proxied}"`;
    }

    if (wrappedValue.startsWith("'") && wrappedValue.endsWith("'")) {
      return `${attr}='${proxied}'`;
    }

    return `${attr}=${proxied}`;
  });

  rewritten = rewritten.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (fullMatch, wrappedValue, dqValue, sqValue) => {
    const rawValue = dqValue ?? sqValue ?? "";
    const proxied = rewriteSrcsetValue(rawValue, baseUrl);
    if (wrappedValue.startsWith("\"") && wrappedValue.endsWith("\"")) {
      return `srcset="${proxied}"`;
    }
    return `srcset='${proxied}'`;
  });

  rewritten = rewritten.replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (fullMatch, wrappedValue, dqValue, sqValue) => {
    const rawStyle = dqValue ?? sqValue ?? "";
    const proxiedStyle = rewriteCssUrls(rawStyle, baseUrl);
    if (wrappedValue.startsWith("\"") && wrappedValue.endsWith("\"")) {
      return `style="${proxiedStyle}"`;
    }
    return `style='${proxiedStyle}'`;
  });

  rewritten = rewritten.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (fullMatch, attrs, cssBody) => {
    return `<style${attrs}>${rewriteCssUrls(cssBody, baseUrl)}</style>`;
  });

  rewritten = rewritten.replace(/(<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=)([^"']+)(["'][^>]*>)/gi, (fullMatch, prefix, rawValue, suffix) => {
    const absolute = toAbsoluteUrl(rawValue, baseUrl);
    if (!absolute) {
      return fullMatch;
    }
    return `${prefix}${toProxyUrl(absolute)}${suffix}`;
  });

  const runtimeBridge = `
<script>
(() => {
  const proxyPrefix = "/proxy?url=";
  const baseUrl = ${JSON.stringify(baseUrl)};
  const skipPattern = /^(?:#|data:|blob:|javascript:|mailto:|tel:)/i;

  function toAbsolute(raw) {
    const value = String(raw || "").trim();
    if (!value || skipPattern.test(value) || value.startsWith(proxyPrefix)) {
      return "";
    }
    try {
      if (value.startsWith("//")) {
        return new URL(baseUrl).protocol + value;
      }
      return new URL(value, baseUrl).toString();
    } catch (_error) {
      return "";
    }
  }

  function proxify(raw) {
    const absolute = toAbsolute(raw);
    return absolute ? (proxyPrefix + encodeURIComponent(absolute)) : raw;
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function(resource, init) {
      if (typeof resource === "string") {
        return nativeFetch.call(this, proxify(resource), init);
      }

      if (resource instanceof Request) {
        const proxiedRequest = new Request(proxify(resource.url), resource);
        return nativeFetch.call(this, proxiedRequest, init);
      }

      return nativeFetch.call(this, resource, init);
    };
  }

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeXhrOpen.call(this, method, proxify(url), ...rest);
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    const link = target && target.closest ? target.closest("a[href]") : null;
    if (!link) {
      return;
    }
    const href = link.getAttribute("href");
    const proxied = proxify(href);
    if (proxied && proxied !== href) {
      link.setAttribute("href", proxied);
    }
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || !form.getAttribute || !form.setAttribute) {
      return;
    }
    const action = form.getAttribute("action") || window.location.href;
    form.setAttribute("action", proxify(action));
  }, true);
})();
</script>`;

  if (/<head\b[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<head\b[^>]*>/i, (match) => `${match}${runtimeBridge}`);
  } else {
    rewritten = `${runtimeBridge}${rewritten}`;
  }

  return rewritten;
}

async function handleProxyRequest(request, response, requestUrl) {
  const targetUrl = requestUrl.searchParams.get("url") || "";
  if (!isHttpUrl(targetUrl)) {
    response.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end("Invalid or missing proxy target URL.");
    return;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      redirect: "follow",
      headers: {
        "user-agent": request.headers["user-agent"] || DEFAULT_PROXY_USER_AGENT,
        "accept": request.headers.accept || "*/*",
        "accept-language": request.headers["accept-language"] || "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": new URL(targetUrl).origin + "/"
      }
    });
  } catch (_error) {
    response.writeHead(502, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end("Failed to fetch target site.");
    return;
  }

  const responseHeaders = {
    "Cache-Control": "no-store"
  };

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (BLOCKED_PROXY_HEADERS.has(lower)) {
      return;
    }
    responseHeaders[key] = value;
  });

  const upstreamType = (upstream.headers.get("content-type") || "").toLowerCase();

  if (request.method === "HEAD") {
    response.writeHead(upstream.status, responseHeaders);
    response.end();
    return;
  }

  if (upstreamType.includes("text/html")) {
    const html = await upstream.text();
    const rewritten = rewriteHtmlDocument(html, targetUrl);
    responseHeaders["Content-Type"] = "text/html; charset=utf-8";
    response.writeHead(upstream.status, responseHeaders);
    response.end(rewritten);
    return;
  }

  if (upstreamType.includes("text/css")) {
    const css = await upstream.text();
    const rewrittenCss = rewriteCssUrls(css, targetUrl);
    responseHeaders["Content-Type"] = upstream.headers.get("content-type") || "text/css; charset=utf-8";
    response.writeHead(upstream.status, responseHeaders);
    response.end(rewrittenCss);
    return;
  }

  const data = await upstream.arrayBuffer();
  response.writeHead(upstream.status, responseHeaders);
  response.end(Buffer.from(data));
}

function sendFile(response, filePath, statusCode = 200) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  fs.readFile(filePath, (error, fileData) => {
    if (error) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end("Not found");
      return;
    }

    response.writeHead(statusCode, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    response.end(fileData);
  });
}

const server = http.createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch (_error) {
    sendJson(response, 400, {
      error: "Invalid request URL."
    });
    return;
  }

  const pathname = decodePathname(requestUrl);

  try {
    if (pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, pathname);
      return;
    }

    if (pathname === "/proxy") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendMethodNotAllowed(response, "GET, HEAD");
        return;
      }

      await handleProxyRequest(request, response, requestUrl);
      return;
    }

    if (pathname.startsWith("/deployments/")) {
      await handleDeploymentAssetRequest(request, response, pathname);
      return;
    }

    await handleMainStaticRequest(request, response, pathname);
  } catch (error) {
    const statusCode = Number(error && error.statusCode) || 500;
    const safeMessage = statusCode >= 500
      ? "Unexpected server error."
      : (error && error.message) || "Request failed.";

    sendJson(response, statusCode, {
      error: safeMessage
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
