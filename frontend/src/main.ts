import { BrowserProvider } from "ethers";
import {
  createD402Client,
  type D402PaymentAttempt,
  type D402Logger,
} from "d402/client";
import {
  D402_PAYMENT_PROOF_HEADER,
  TransactionPreparedEvent,
} from "d402/core";
import "./style.css";

declare global {
  interface Window {
    ethereum?: InjectedEthereumProvider;
  }
}

interface InjectedEthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface DemoConfig {
  chainId: number;
  payeeAddress: `0x${string}`;
  resource: string;
  maxAmount: string;
}

interface OracleResponse {
  answer: string;
  model: string;
}

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const checkButton = getElement<HTMLButtonElement>("check");
const status = getElement<HTMLParagraphElement>("status");
const transactionList = getElement<HTMLElement>("transaction-list");
const resultCard = getElement<HTMLElement>("result-card");
const answer = getElement<HTMLElement>("answer");
const answerCaption = getElement<HTMLElement>("answer-caption");
const paymentDetails = getElement<HTMLElement>("payment-details");
const log: D402Logger = (record) => {
  console.log("[d402-client]", record.event, record.message, record.context ?? {});
};

checkButton.addEventListener("click", () => void runDemo());

async function runDemo(): Promise<void> {
  resetDemo();
  checkButton.disabled = true;
  try {
    if (window.ethereum === undefined) {
      throw new Error("Install a browser wallet such as MetaMask first.");
    }

    setStatus("Connecting your wallet…");
    const injectedProvider = window.ethereum;
    await injectedProvider.request({ method: "eth_requestAccounts" });
    await ensureGnosisNetwork(injectedProvider);

    setStatus("Discovering the protected server's d402 policy…");
    const config = await readDemoConfig();
    const provider = new BrowserProvider(injectedProvider);
    const signer = await provider.getSigner();
    let phase: "create" | "settle" = "create";

    const client = await createD402Client({
      provider,
      signer,
      confirmations: 1,
      fetch: createProgressFetch(() => {
        setStatus("Payment created. Sending proof for d402 verification…");
      }),
      logger: log,
      onEvent(event) {
        if (!(event instanceof TransactionPreparedEvent)) return;
        renderTransaction(phase, event);
        setStatus(phase === "create"
          ? "d402 prepared the payment. Approve it in your wallet…"
          : "d402 prepared settlement. Approve it in your wallet…");
      },
      policy: {
        allowedChains: [config.chainId],
        allowedTokens: [null],
        allowedPayees: [config.payeeAddress],
        allowedResources: [config.resource],
        maxAmount: config.maxAmount,
        maxExpiryWindowSec: 300,
        minSettlementWindowSec: 30,
      },
    });

    setStatus("Requesting the protected AI resource…");
    const result = await client.d402Fetch(config.resource);
    if (result.payment === undefined) {
      throw new Error("The server did not request a d402 payment.");
    }

    if (!result.response.ok) {
      throw new Error(`The protected server returned HTTP ${result.response.status}.`);
    }

    setStatus("d402 verified. Waiting on the local AI 8-Ball response…");
    const oracle = await result.response.json() as OracleResponse;

    renderResult(oracle, result.payment);
    setStatus("AI response accepted. Preparing settlement…");

    const settlePayment = client.executor.settlePayment;
    if (settlePayment === undefined) {
      throw new Error("The configured d402 client cannot settle payments.");
    }
    phase = "settle";
    const settlement = await settlePayment(result.payment.payment);
    appendPaymentDetail(
      "Settlement transaction",
      explorerLink(shorten(settlement.txHash), transactionUrl(settlement.txHash)),
    );
    setStatus("Payment settled. The 8-ball has spoken.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "The payment request failed.", true);
  } finally {
    checkButton.disabled = false;
  }
}

async function readDemoConfig(): Promise<DemoConfig> {
  const response = await fetch(apiUrl + "/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read demo policy (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) || typeof body.chainId !== "number" ||
    typeof body.payeeAddress !== "string" || !body.payeeAddress.startsWith("0x") ||
    typeof body.resource !== "string" || typeof body.maxAmount !== "string"
  ) {
    throw new Error("The server returned an invalid demo policy.");
  }
  return body as unknown as DemoConfig;
}

function createProgressFetch(onPaidRequest: () => void): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (headers.has(D402_PAYMENT_PROOF_HEADER)) onPaidRequest();
    return globalThis.fetch(input, { ...init, headers });
  };
}

function renderTransaction(
  phase: "create" | "settle",
  event: TransactionPreparedEvent,
): void {
  const transaction = event.transaction;
  const card = document.createElement("details");
  card.className = "transaction-card";
  const heading = document.createElement("summary");
  heading.className = "transaction-heading";
  const copy = document.createElement("div");
  copy.append(
    element("p", "section-label", "Prepared by d402"),
    element("h2", "", phase === "create" ? "Create USDS payment" : "Settle payment"),
  );
  heading.append(copy);
  card.append(heading);

  const content = document.createElement("div");
  content.className = "transaction-content";
  content.append(element(
    "p",
    "transaction-description",
    phase === "create"
      ? "Fund a native USDS payment on Gnosis."
      : "Release the accepted payment to the protected server.",
  ));
  const amount = document.createElement("div");
  amount.className = "amount-block";
  amount.append(
    element("span", "field-label", "Transaction value"),
    element("strong", "", `${formatWei(transaction.value)} wei USDS`),
    element("span", "amount-caption", formatNominalUsd(transaction.value)),
  );
  content.append(amount);

  const grid = document.createElement("dl");
  grid.className = "transaction-grid";
  addDefinition(grid, "Network", transaction.chainId === 100 ? "Gnosis · Chain 100" : `Chain ${transaction.chainId}`);
  addDefinition(grid, "Signer", transaction.preview?.signer ?? transaction.signerHint ?? "Connected wallet");
  addDefinition(grid, "Destination", shorten(transaction.to));
  content.append(grid);

  const technical = document.createElement("details");
  technical.className = "technical-details";
  technical.append(element("summary", "", "View technical transaction data"));
  const raw = document.createElement("pre");
  raw.textContent = JSON.stringify(transaction, null, 2);
  technical.append(raw);
  content.append(technical);
  card.append(content);
  transactionList.append(card);
}

function renderResult(
  oracle: OracleResponse,
  paid: D402PaymentAttempt,
): void {
  answer.textContent = oracle.answer;
  answerCaption.textContent = `Generated by ${oracle.model} after d402 verified the payment.`;
  paymentDetails.replaceChildren();
  appendPaymentDetail("Amount", `${formatWei(paid.paymentRequest.netAmount)} wei USDS · ${formatNominalUsd(paid.paymentRequest.netAmount)}`);
  appendPaymentDetail("Payee", shorten(paid.paymentRequest.payeeAddress));
  appendPaymentDetail("Payer", shorten(paid.payment.payerAddress));
  appendPaymentDetail("Payment ID", shorten(paid.payment.paymentId));
  appendPaymentDetail("Payment address", shorten(paid.payment.paymentAddress));
  appendPaymentDetail(
    "Creation transaction",
    explorerLink(shorten(paid.payment.txHash), transactionUrl(paid.payment.txHash)),
  );
  resultCard.hidden = false;
}

function appendPaymentDetail(label: string, value: string | HTMLElement): void {
  addDefinition(paymentDetails, label, value);
}

function addDefinition(parent: HTMLElement, label: string, value: string | HTMLElement): void {
  const wrapper = document.createElement("div");
  const description = document.createElement("dd");
  description.append(value);
  wrapper.append(element("dt", "", label), description);
  parent.append(wrapper);
}

function explorerLink(label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.textContent = `${label} ↗`;
  return link;
}

function transactionUrl(hash: string): string {
  return `https://gnosisscan.io/tx/${encodeURIComponent(hash)}`;
}

function resetDemo(): void {
  transactionList.replaceChildren();
  paymentDetails.replaceChildren();
  resultCard.hidden = true;
  status.classList.remove("error");
}

function setStatus(message: string, failed = false): void {
  status.textContent = message;
  status.classList.toggle("error", failed);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className.length > 0) result.className = className;
  result.textContent = text;
  return result;
}

function formatWei(value: string): string {
  return BigInt(value).toLocaleString("en-US");
}

function formatNominalUsd(value: string): string {
  const amount = BigInt(value);
  const unit = 10n ** 18n;
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction.length === 0 ? `$${whole}.00 nominal USD` : `≈ $${whole}.${fraction} nominal USD`;
}

function shorten(value: string): string {
  return value.length < 18 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function ensureGnosisNetwork(provider: InjectedEthereumProvider): Promise<void> {
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (currentChainId === "0x64") return;
  setStatus("Switching your wallet to Gnosis…");
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x64" }],
    });
  } catch (error) {
    if (walletErrorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x64",
        chainName: "Gnosis",
        nativeCurrency: { name: "xDAI", symbol: "XDAI", decimals: 18 },
        rpcUrls: ["https://rpc.gnosischain.com"],
        blockExplorerUrls: ["https://gnosisscan.io"],
      }],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x64" }],
    });
  }
}

function walletErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}
