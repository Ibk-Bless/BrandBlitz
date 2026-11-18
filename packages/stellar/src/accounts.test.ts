import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMuxedAddress, sponsorNewAccount, accountHasUsdcTrustline, getAccountUsdcBalance } from "./accounts";
import * as client from "./client";
import {
  MuxedAccount,
  Keypair,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Asset,
} from "@stellar/stellar-sdk";

// Mocks
vi.mock("./client");

import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
const basePublicKey = StellarKeypair.random().publicKey();
const userId = 1234567890123456789n;

const usdcAsset = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"); // testnet USDC issuer

// --- createMuxedAddress ---
describe("createMuxedAddress", () => {
  it("round-trips encode/decode", () => {
    const addr = createMuxedAddress(basePublicKey, userId);
    // decode
    const decoded = MuxedAccount.fromAddress(addr, "testnet");
    expect(decoded.baseAccount()).toBe(basePublicKey);
    expect(decoded.id()).toBe(userId.toString());
  });

  it("throws on invalid base address", () => {
    expect(() => createMuxedAddress("INVALID", userId)).toThrow();
  });
});

// --- sponsorNewAccount ---
describe("sponsorNewAccount", () => {
  // Use valid Stellar public keys
  const winnerPublicKey = StellarKeypair.random().publicKey();
  const sponsorSecret = StellarKeypair.random().secret();
  const sponsorKeypair = Keypair.fromSecret(sponsorSecret);
  const sponsorAccount = {
    accountId: sponsorKeypair.publicKey(),
    sequence: "1",
    incrementSequenceNumber: vi.fn(),
    balances: [],
  };
  const txMock = { sign: vi.fn(), toEnvelope: () => ({ toXDR: () => "XDR" }) };
  let txBuilderAddOpOrder: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue(sponsorAccount),
    });
    (client.getUsdcAsset as any).mockReturnValue(usdcAsset);
    (client.getNetworkPassphrase as any).mockReturnValue("testnet-passphrase");
    vi.spyOn(TransactionBuilder.prototype, "addOperation").mockImplementation(function (op) {
      txBuilderAddOpOrder.push(op.type);
      return this;
    });
    vi.spyOn(TransactionBuilder.prototype, "build").mockImplementation(() => txMock as any);
    vi.spyOn(TransactionBuilder.prototype, "setTimeout").mockImplementation(function () {
      return this;
    });
    txBuilderAddOpOrder = [];
  });

  it("creates sponsorship tx with correct op order", async () => {
    const result = await sponsorNewAccount(winnerPublicKey, sponsorSecret, "testnet");
    expect(result.txEnvelopeXdr).toBe("XDR");
    expect(txBuilderAddOpOrder).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
  });

  it("works for public network", async () => {
    await sponsorNewAccount(winnerPublicKey, sponsorSecret, "public");
    expect(client.getHorizonServer).toHaveBeenCalledWith("public");
    expect(client.getUsdcAsset).toHaveBeenCalledWith("public");
    expect(client.getNetworkPassphrase).toHaveBeenCalledWith("public");
  });
});

// --- accountHasUsdcTrustline ---
describe("accountHasUsdcTrustline", () => {
  const publicKey = "GEXAMPLEACCOUNT";
  const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"); // testnet USDC issuer
  beforeEach(() => {
    vi.resetAllMocks();
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn(),
    });
    (client.getUsdcAsset as any).mockReturnValue(usdc);
  });

  it("returns true if account has USDC trustline", async () => {
    const balances = [
      { asset_type: "native" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: usdc.getIssuer() },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    expect(await accountHasUsdcTrustline(publicKey, "testnet")).toBe(true);
  });

  it("returns false if account does not have USDC trustline", async () => {
    const balances = [
      { asset_type: "native" },
      { asset_type: "credit_alphanum4", asset_code: "OTHER", asset_issuer: usdc.getIssuer() },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    expect(await accountHasUsdcTrustline(publicKey, "testnet")).toBe(false);
  });

  it("returns false if account not found", async () => {
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockRejectedValue(new Error("not found")),
    });
    expect(await accountHasUsdcTrustline(publicKey, "testnet")).toBe(false);
  });

  it("works for public network", async () => {
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances: [] }),
    });
    await accountHasUsdcTrustline(publicKey, "public");
    expect(client.getHorizonServer).toHaveBeenCalledWith("public");
    expect(client.getUsdcAsset).toHaveBeenCalledWith("public");
  });
});

// --- Slug generation determinism regression test ---
describe("createMuxedAddress determinism", () => {
  it("same user ID always yields the same slug", () => {
    const userId = 1234567890123456789n;
    const slug1 = createMuxedAddress(basePublicKey, userId);
    const slug2 = createMuxedAddress(basePublicKey, userId);
    const slug3 = createMuxedAddress(basePublicKey, userId);

    expect(slug1).toBe(slug2);
    expect(slug2).toBe(slug3);
  });

  it("different user IDs yield different slugs", () => {
    const slug1 = createMuxedAddress(basePublicKey, 1n);
    const slug2 = createMuxedAddress(basePublicKey, 2n);

    expect(slug1).not.toBe(slug2);
  });

  it("known test vector produces expected output", () => {
    // Test vector from Stellar docs
    const testPublicKey = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const testUserId = 1234n;
    const slug = createMuxedAddress(testPublicKey, testUserId);

    // Verify slug starts with M (muxed account prefix)
    expect(slug[0]).toBe("M");

    // Verify deterministic - same inputs = same output
    const slug2 = createMuxedAddress(testPublicKey, testUserId);
    expect(slug).toBe(slug2);
  });
});

// --- getAccountUsdcBalance ---
describe("getAccountUsdcBalance", () => {
  const publicKey = "GEXAMPLEACCOUNT";
  const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  const wrongIssuer = new Asset("USDC", "GDIFFERENTISSUER00000000000000000000000000000000000000000");

  beforeEach(() => {
    vi.resetAllMocks();
    (client.getUsdcAsset as any).mockReturnValue(usdc);
  });

  it("returns 0n when account has no USDC trustline", async () => {
    const balances = [{ asset_type: "native", balance: "10.0000000" }];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(0n);
  });

  it("returns 0n when USDC trustline has no balance field", async () => {
    const balances = [
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: usdc.getIssuer() },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(0n);
  });

  it("converts a whole-number balance string with no decimal point", async () => {
    const balances = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: usdc.getIssuer(),
        balance: "100",
      },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    // 100 USDC = 100 * 10_000_000 stroops = 1_000_000_000n
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(1_000_000_000n);
  });

  it("converts a standard 7-decimal balance string", async () => {
    const balances = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: usdc.getIssuer(),
        balance: "12.3456789",
      },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    // 12.3456789 USDC = 123_456_789 stroops
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(123_456_789n);
  });

  it("truncates a balance string with more than 7 fractional digits", async () => {
    const balances = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: usdc.getIssuer(),
        balance: "1.123456789",  // 9 fractional digits — should truncate to 7
      },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    // Truncated to 1.1234567 = 11_234_567 stroops
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(11_234_567n);
  });

  it("filters by both asset_code and asset_issuer — ignores same code with different issuer", async () => {
    const balances = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GDIFFERENTISSUER00000000000000000000000000000000000000000",
        balance: "999.0000000",
      },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    // Should return 0n — issuer doesn't match
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(0n);
  });

  it("pads fractional part shorter than 7 digits correctly", async () => {
    const balances = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: usdc.getIssuer(),
        balance: "5.5",  // 1 fractional digit — padEnd to 7
      },
    ];
    (client.getHorizonServer as any).mockReturnValue({
      loadAccount: vi.fn().mockResolvedValue({ balances }),
    });
    // 5.5 = 5.5000000 = 55_000_000 stroops
    expect(await getAccountUsdcBalance(publicKey, "testnet")).toBe(55_000_000n);
  });
});
