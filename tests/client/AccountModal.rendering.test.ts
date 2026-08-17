import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMeResponse } from "../../src/core/ApiSchemas";

// ─── Mocks (mirrors tests/client/clan/ClanModalTestUtils.ts factories) ──────

vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
  setMarketingConsent: vi.fn(async () => true),
  getApiBase: vi.fn(() => ""),
}));

vi.mock("../../src/client/Auth", () => ({
  discordLogin: vi.fn(),
  googleLogin: vi.fn(),
  linkGoogle: vi.fn(async () => true),
  logOut: vi.fn(async () => true),
  reauthAfterCrazyGamesChange: vi.fn(async () => false),
  sendMagicLink: vi.fn(async () => true),
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  showToast: vi.fn(),
  getDiscordAvatarUrl: vi.fn(() => null),
  copyToClipboard: vi.fn(),
  renderNumber: vi.fn((n: number) => String(n)),
  getMapName: vi.fn((m: string) => m),
  renderDuration: vi.fn(() => ""),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
    isAvailable: false,
  },
}));

vi.mock("../../src/client/Cosmetics", () => ({
  fetchCosmetics: vi.fn(async () => null),
  translateCosmetic: vi.fn((v: unknown) => v),
}));

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

import { AccountModal } from "../../src/client/AccountModal";

function makeUserMe(
  overrides: Partial<UserMeResponse["user"]>,
): UserMeResponse {
  return {
    user: { ...overrides },
    player: {
      publicId: "test-player",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [] },
      friends: [],
      subscription: null,
      currency: { soft: 100, hard: 10 },
    },
  };
}

describe("AccountModal — rendering", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    if (!customElements.get("account-modal")) {
      customElements.define("account-modal", AccountModal);
    }
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
    delete (window as { openfrontDesktop?: unknown }).openfrontDesktop;
  });

  // Directly install a resolved userMeResponse and flip off the loading state,
  // bypassing onOpen()'s network calls — this mirrors ClanModalTestUtils'
  // setState() helper, but userMeResponse is a plain private field (not a Lit
  // @state), so we force a render manually afterward.
  async function setLoggedInUser(userMe: UserMeResponse): Promise<void> {
    (
      modal as unknown as { userMeResponse: UserMeResponse | null }
    ).userMeResponse = userMe;
    (modal as unknown as { isLoadingUser: boolean }).isLoadingUser = false;
    modal.requestUpdate();
    await modal.updateComplete;
  }

  it("shows the logged-in view for a Discord user", async () => {
    const userMe = makeUserMe({
      discord: {
        id: "1",
        avatar: null,
        username: "player",
        global_name: null,
        discriminator: "0",
      },
    });
    await setLoggedInUser(userMe);

    const text = modal.textContent ?? "";

    // Still a logged-in view, not the login-options screen.
    expect(modal.querySelector("currency-display")).toBeTruthy();
    expect(text).toContain("account_modal.log_out");
  });

  // Desktop re-entry to the account-linking gate. The Electron preload exposes
  // `window.openfrontDesktop.showLinkGate()` for exactly this purpose; it is
  // absent entirely on plain web, which is the signal the action guards on.
  describe("desktop link-gate action", () => {
    function findLinkGateButton(): HTMLButtonElement | undefined {
      return Array.from(modal.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("account_modal.link_existing_account"),
      );
    }

    it("renders and calls showLinkGate() when the desktop bridge is present", async () => {
      const showLinkGate = vi.fn(async () => undefined);
      (window as unknown as { openfrontDesktop: unknown }).openfrontDesktop = {
        showLinkGate,
      };

      const userMe = makeUserMe({
        discord: {
          id: "1",
          avatar: null,
          username: "player",
          global_name: null,
          discriminator: "0",
        },
      });
      await setLoggedInUser(userMe);

      const button = findLinkGateButton();
      expect(button).toBeTruthy();

      button!.click();
      expect(showLinkGate).toHaveBeenCalledTimes(1);
    });

    it("does not render when the desktop bridge is absent (plain web)", async () => {
      const userMe = makeUserMe({
        discord: {
          id: "1",
          avatar: null,
          username: "player",
          global_name: null,
          discriminator: "0",
        },
      });
      await setLoggedInUser(userMe);

      expect(findLinkGateButton()).toBeUndefined();
    });

    // Pins the resolved ambiguity from the plan: guard on the function we
    // actually call, not a sibling property. A bridge exposing `linkGate` but
    // no callable `showLinkGate` must not render a dead button.
    it("does not render when the bridge exists but showLinkGate is not a function", async () => {
      (window as unknown as { openfrontDesktop: unknown }).openfrontDesktop = {
        linkGate: { open: vi.fn() },
      };

      const userMe = makeUserMe({
        discord: {
          id: "1",
          avatar: null,
          username: "player",
          global_name: null,
          discriminator: "0",
        },
      });
      await setLoggedInUser(userMe);

      expect(findLinkGateButton()).toBeUndefined();
    });
  });
});
