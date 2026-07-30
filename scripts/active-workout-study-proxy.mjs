import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.STUDY_PROXY_PORT ?? 3110);
const backendPort = Number(process.env.STUDY_BACKEND_PORT ?? 3100);
let control = { mode: "pass", delayMs: 0, remaining: 0 };
const actions = [];

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = http.createServer((request, response) => {
  const controlUrl = new URL(request.url ?? "/", `http://127.0.0.1:${listenPort}`);
  if (controlUrl.pathname === "/sign-in" && controlUrl.searchParams.has("study-control")) {
    const command = controlUrl.searchParams.get("study-control");
    if (command === "reset") {
      actions.length = 0;
      control = { mode: "pass", delayMs: 0, remaining: 0 };
    } else if (command === "set") {
      const mode = controlUrl.searchParams.get("mode") ?? "pass";
      if (!["pass", "delay", "fail", "offline"].includes(mode)) {
        json(response, 400, { error: "unsupported mode" });
        return;
      }
      control = {
        mode,
        delayMs: Math.max(0, Number(controlUrl.searchParams.get("delayMs") ?? 0)),
        remaining: Math.max(0, Number(controlUrl.searchParams.get("remaining") ?? 1)),
      };
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<pre id="study-data">${JSON.stringify({ control, actions })}</pre>`);
    return;
  }
  if (request.url === "/study-control" && request.method === "GET") {
    json(response, 200, { control, actions });
    return;
  }
  if (request.url === "/study-reset" && request.method === "GET") {
    actions.length = 0;
    control = { mode: "pass", delayMs: 0, remaining: 0 };
    json(response, 200, { ok: true });
    return;
  }
  if (request.url?.startsWith("/study-set?") && request.method === "GET") {
    const url = new URL(request.url, `http://127.0.0.1:${listenPort}`);
    const mode = url.searchParams.get("mode") ?? "pass";
    if (!["pass", "delay", "fail", "offline"].includes(mode)) {
      json(response, 400, { error: "unsupported mode" });
      return;
    }
    control = {
      mode,
      delayMs: Math.max(0, Number(url.searchParams.get("delayMs") ?? 0)),
      remaining: Math.max(0, Number(url.searchParams.get("remaining") ?? 1)),
    };
    json(response, 200, { control });
    return;
  }
  if (request.url === "/study-control" && request.method === "DELETE") {
    actions.length = 0;
    control = { mode: "pass", delayMs: 0, remaining: 0 };
    json(response, 200, { ok: true });
    return;
  }
  if (request.url === "/study-control" && request.method === "POST") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const next = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!["pass", "delay", "fail", "offline"].includes(next.mode)) {
        json(response, 400, { error: "unsupported mode" });
        return;
      }
      control = {
        mode: next.mode,
        delayMs: Math.max(0, Number(next.delayMs ?? 0)),
        remaining: Math.max(0, Number(next.remaining ?? 1)),
      };
      json(response, 200, { control });
    });
    return;
  }

  // Every application POST in this study is a Next Server Action. Some browser
  // surfaces intentionally hide the internal action header from extensions, so
  // method + exclusion of the private control endpoint is the cross-browser
  // boundary used by this external harness.
  const isAction = request.method === "POST";
  const affected = isAction && control.mode !== "pass" && control.remaining > 0;
  const mode = affected ? control.mode : "pass";
  const delayMs = affected ? control.delayMs : 0;
  const action = isAction
    ? {
        sequence: actions.length + 1,
        receivedAtMs: Date.now(),
        respondedAtMs: null,
        mode,
        status: null,
      }
    : null;
  if (action) actions.push(action);
  if (affected) {
    control = { ...control, remaining: control.remaining - 1 };
  }

  if (mode === "fail") {
    action.status = 500;
    action.respondedAtMs = Date.now();
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("Synthetic active-workout study failure");
    return;
  }
  if (mode === "offline") {
    action.status = 0;
    action.respondedAtMs = Date.now();
    request.socket.destroy();
    return;
  }

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: backendPort,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        ...(isAction ? { origin: `http://127.0.0.1:${listenPort}` } : {}),
      },
    },
    (upstreamResponse) => {
      const finish = (body) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        response.end(body);
        if (action) {
          action.status = upstreamResponse.statusCode ?? 502;
          action.respondedAtMs = Date.now();
        }
      };
      if (mode !== "delay") {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.on("end", () => {
          if (action) {
            action.status = upstreamResponse.statusCode ?? 502;
            action.respondedAtMs = Date.now();
          }
        });
        return;
      }
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        setTimeout(() => finish(Buffer.concat(chunks)), delayMs);
      });
    }
  );
  upstream.on("error", () => {
    if (action) {
      action.status = 0;
      action.respondedAtMs = Date.now();
    }
    response.destroy();
  });
  request.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(JSON.stringify({ listenPort, backendPort }));
});

server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(backendPort, "127.0.0.1", () => {
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(signal === "SIGINT" ? 130 : 143)));
}
