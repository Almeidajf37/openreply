import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createOAuthState,
  createMetisOAuthState,
  decryptToken,
  encryptToken,
  isMetisOAuthStateForAuthority,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });

  it("marks only signed bridge-issued state as a Metis return", () => {
    const state = createMetisOAuthState("workspace_123", {
      intentId: "11111111-1111-4111-8111-111111111111",
      actorId: "22222222-2222-4222-8222-222222222222",
      metisOrganizationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(verifyOAuthState(state)).toMatchObject({
      workspaceId: "workspace_123",
      source: "metis",
      intentId: "11111111-1111-4111-8111-111111111111",
      actorId: "22222222-2222-4222-8222-222222222222",
      metisOrganizationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });

  it("accepts a Metis callback only for the configured workspace and organization", () => {
    const signed = createMetisOAuthState("workspace_123", {
      intentId: "11111111-1111-4111-8111-111111111111",
      actorId: "22222222-2222-4222-8222-222222222222",
      metisOrganizationId: "33333333-3333-4333-8333-333333333333",
    });
    const state = verifyOAuthState(signed);

    expect(isMetisOAuthStateForAuthority(
      state,
      "workspace_123",
      "33333333-3333-4333-8333-333333333333",
    )).toBe(true);
    expect(isMetisOAuthStateForAuthority(
      state,
      "workspace_other",
      "33333333-3333-4333-8333-333333333333",
    )).toBe(false);
    expect(isMetisOAuthStateForAuthority(
      state,
      "workspace_123",
      "44444444-4444-4444-8444-444444444444",
    )).toBe(false);
    expect(isMetisOAuthStateForAuthority(state, undefined, undefined)).toBe(false);
  });
});
