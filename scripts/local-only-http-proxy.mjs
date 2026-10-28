#!/usr/bin/env node

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-readable-spacing -- This process validates dynamic Node HTTP and TCP boundary values. */
import { createServer } from "node:http";
import process from "node:process";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const target = new URL(process.argv[2] ?? "");

if (!LOOPBACK_HOSTS.has(target.hostname)) {
	throw new Error("The guarded target must use a loopback host");
}

function isRedirect(status) {
	return status >= 300 && status < 400;
}

function copyRequestHeaders(headers) {
	const copied = new Headers();

	for (const [name, value] of Object.entries(headers)) {
		if (value == null || name === "host" || name === "content-length") continue;
		if (Array.isArray(value)) {
			for (const item of value) copied.append(name, item);
		} else {
			copied.set(name, value);
		}
	}

	return copied;
}

const server = createServer(async (request, response) => {
	try {
		const incoming = new URL(request.url ?? "/", "http://loopback-guard.invalid");
		const destination = new URL(target);
		const targetPath = target.pathname.replace(/\/$/, "");
		destination.pathname = incoming.pathname === "/" ? target.pathname : `${targetPath}${incoming.pathname}`;
		destination.search = incoming.search;

		if (!LOOPBACK_HOSTS.has(destination.hostname)) {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "non_loopback_destination_refused" }));
			return;
			}

			const method = request.method ?? "GET";
			const options = {
				method,
				headers: copyRequestHeaders(request.headers),
				body: method === "GET" || method === "HEAD" ? undefined : request,
				redirect: "manual",
			};

			if (method !== "GET" && method !== "HEAD") options.duplex = "half";

			const upstream = await fetch(destination, options);
		const location = upstream.headers.get("location");

		if (isRedirect(upstream.status) && location) {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "redirect_refused" }));
			return;
		}

		const headers = {};

		for (const [name, value] of upstream.headers.entries()) {
			if (name === "content-length" || name === "transfer-encoding") continue;
			headers[name] = value;
		}

		response.writeHead(upstream.status, headers);
		response.end(Buffer.from(await upstream.arrayBuffer()));
	} catch {
		response.writeHead(502, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "loopback_proxy_failed" }));
	}
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();

	if (address == null || typeof address === "string") {
		throw new Error("The local-only proxy did not receive a TCP port");
	}

	process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
