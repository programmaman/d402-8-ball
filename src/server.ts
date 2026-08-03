import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { JsonRpcProvider, Wallet } from "ethers";
import { payable, type D402Logger } from "d402/server";

import { generateFortune } from "./oracle.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const chainId = Number(process.env.CHAIN_ID ?? "100");
const rpcUrl = process.env.GNOSIS_RPC_URL ?? "https://rpc.gnosischain.com";
const paymentAmountWei = BigInt(process.env.PAYMENT_AMOUNT_WEI ?? "1000");
const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "llama3.2:1b";
const payeePrivateKey = process.env.PAYEE_PRIVATE_KEY;

if (payeePrivateKey === undefined || payeePrivateKey === "") {
  throw new Error("PAYEE_PRIVATE_KEY is required");
}

const provider = new JsonRpcProvider(rpcUrl);
const payeeSigner = new Wallet(payeePrivateKey, provider);
const payeeAddress = payeeSigner.address as `0x${string}`;
const d402Logger: D402Logger = (record) => {
  console.log("[d402-server]", record.event, record.message, record.context ?? {});
};
const oracleRoute = payable({
  paymentConfig: {
    provider,
    signer: payeeSigner,
    confirmations: 1,
    identifier: "server",
    settlementWindow: 60,
    logger: d402Logger,
  },
  terms: (request) => ({
    chainId,
    payeeAddress,
    tokenAddress: null,
    netAmount: paymentAmountWei.toString() as `${bigint}`,
    agreement: {
      id: "container-demo:ai-8-ball:v1",
    },
    expiresAtUnixSec: Math.floor(Date.now() / 1000) + 300,
    resource: new URL(request.url).toString(),
    method: "GET",
  }),
  handler: async (_request, context) => {
    console.log("[oracle-server] payment verified", {
      paymentId: context.payment.paymentId,
      paymentAddress: context.payment.paymentAddress,
      state: context.payment.state,
    });

    const fortune = await generateFortune({
      baseUrl: ollamaUrl,
      model: ollamaModel,
    });

    return Response.json({
      answer: fortune.answer,
      model: fortune.model,
      paymentId: context.payment.paymentId,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  },
});

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
    console.log("[oracle-server] request", {
      method: request.method,
      path: url.pathname,
      hasPaymentProof: request.headers["d402-payment-proof"] !== undefined,
    });
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "D402-Payment-Proof, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/config") {
      await sendResponse(response, Response.json({
        chainId,
        payeeAddress,
        resource: new URL("/oracle", url.origin).toString(),
        maxAmount: paymentAmountWei.toString(),
      }, { headers: { "Cache-Control": "no-store" } }), url.pathname, startedAt);
      return;
    }

    if (request.method === "GET" && url.pathname === "/oracle") {
      const webRequest = toWebRequest(request, url);
      const webResponse = await oracleRoute(webRequest);
      await sendResponse(response, webResponse, url.pathname, startedAt);
      return;
    }

    await sendResponse(response, Response.json({ error: "not-found" }, { status: 404 }), url.pathname, startedAt);
  } catch (error) {
    console.error("[oracle-server] request failed", error);
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    await sendResponse(
      response,
      Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      ),
      request.url ?? "/",
      startedAt,
    );
  }
});

server.listen(port, host, () => {
  console.log(`d402 oracle server listening on http://localhost:${port}`);
});

function toWebRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }

  return new Request(url, {
    method: request.method ?? "GET",
    headers,
  });
}

async function sendResponse(
  response: ServerResponse,
  webResponse: Response,
  path: string,
  startedAt: number,
): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.flushHeaders();
  if (webResponse.body !== null) {
    const reader = webResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await once(response, "drain");
    }
  }
  response.end();
  console.log("[oracle-server] response", {
    path,
    status: webResponse.status,
    durationMs: Date.now() - startedAt,
  });
}
