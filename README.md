# d402 local AI 8-ball

> **LOCAL USE ONLY**

This is a compact browser-wallet presentation of the d402 payment flow:

1. A browser client connects to MetaMask or another injected wallet.
2. `GET /oracle` returns canonical d402 payment terms.
3. The client creates a tiny native USDS payment on Gnosis and retries with proof.
4. The server verifies the proof and asks a local Ollama model for an answer.
5. The client approves settlement after the successful paid response.

The connected browser wallet is the payer. `PAYEE_PRIVATE_KEY` belongs only to
the protected server. Use disposable, minimally funded wallets.

## Prerequisites

- Node.js 24 or newer
- A funded, disposable Gnosis wallet for the browser
- A funded, disposable Gnosis payee key for the server
- [Ollama](https://ollama.com/download)

## Quick start

From the repository root, install the frontend dependencies:

```sh
cd frontend
npm install
cd ..
```

Create the local server configuration:

```sh
cp .env.example .env
```

Set a disposable funded `PAYEE_PRIVATE_KEY` in `.env`. Then download and start
the model:

```sh
ollama pull llama3.2:1b
ollama serve
```

In a second terminal, start the protected server:

```sh
node --env-file=.env --import tsx src/server.ts
```

In a third terminal, start the frontend on loopback:

```sh
cd frontend
npm run dev -- --host 127.0.0.1
```

Open <http://localhost:5173>, connect a disposable funded wallet on Gnosis, and
click **Connect wallet and ask**. The wallet normally asks for two approvals:
create the payment, then settle it after the AI response.

The frontend uses `http://localhost:3000` for the API by default. Override it
with `VITE_API_URL` only for another local address.

## Configuration

```text
GNOSIS_RPC_URL=https://rpc.gnosischain.com
CHAIN_ID=100
PAYEE_PRIVATE_KEY=0x...
PORT=3000
PAYMENT_AMOUNT_WEI=1000
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:1b
```

The actual d402 payment challenge and its canonical terms come from the initial
`GET /oracle` response. Before making that request, this demo reads `GET /config`
only to build a client-side allowlist for the expected chain, token, payee,
resource, and maximum amount. The d402 client then checks the challenge returned
by `/oracle` against that allowlist before creating a transaction.

Because `/config` is served by the same server as `/oracle`, it is demo
configuration rather than an independent trust source or production security
boundary. A production client should validate challenges against expectations
configured through a trusted source.

The model receives a fixed prompt. Visitor text is not sent to Ollama.

## Endpoints

```text
GET /config -> demo allowlist inputs (not a payment challenge)
GET /oracle -> canonical d402 challenge, then paid AI response
```

The successful oracle response is:

```json
{
  "answer": "Wait for a clearer signal before committing.",
  "model": "llama3.2:1b",
  "paymentId": "0x..."
}
```

## Validation

From the repository root:

```sh
node --import tsx --test test/*.ts
npx tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext \
  --target ES2024 --types node --skipLibCheck \
  src/*.ts test/*.ts
cd frontend && npm run build
```

The tests use mocked Ollama responses; they do not spend funds or download a
model.
