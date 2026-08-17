import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import { PlayerStatsTree, UserMeResponse } from "../core/ApiSchemas";
import { assetUrl } from "../core/AssetUrls";
import { Cosmetics } from "../core/CosmeticSchemas";
import { hasLinkedIdentity } from "./AccountIdentity";
import {
  fetchPlayerById,
  getUserMe,
  invalidateUserMe,
  setMarketingConsent,
} from "./Api";
import {
  discordLogin,
  googleLogin,
  logOut,
  reauthAfterCrazyGamesChange,
  sendMagicLink,
} from "./Auth";
import "./components/baseComponents/stats/DiscordUserHeader";
import "./components/baseComponents/stats/PlayerGameHistoryView";
import type { PlayerGameHistoryCache } from "./components/baseComponents/stats/PlayerGameHistoryView";
import "./components/baseComponents/stats/PlayerStatsTable";
import "./components/baseComponents/stats/PlayerStatsTree";
import { BaseModal } from "./components/BaseModal";
import "./components/CopyButton";
import "./components/CurrencyDisplay";
import "./components/Difficulties";
import "./components/FriendsList";
import "./components/RewardsPanel";
import type { RewardsChangedDetail } from "./components/RewardsPanel";
import "./components/SubscriptionPanel";
import { showToast } from "./components/Toast";
import { modalHeader } from "./components/ui/ModalHeader";
import "./components/UsernamePanel";
import { fetchCosmetics } from "./Cosmetics";
import { crazyGamesSDK, type CrazyGamesUser } from "./CrazyGamesSDK";
import { playerProfileUrl } from "./PlayerProfileModal";
import { translateText } from "./Utils";

// window.openfrontDesktop is declared `unknown` by DesktopShell.ts (kept loose
// there on purpose). We know the one function we need, so narrow it locally
// rather than re-declaring the global (a second `declare global` with a
// different type triggers TS2717).
//
// Guard on `showLinkGate` specifically, the function actually invoked below —
// not on a sibling property like `linkGate` (a separate namespace used by the
// gate page itself) — so a rename of one can't silently leave this button
// wired to nothing.
function desktopLinkGateBridge():
  | { showLinkGate: () => Promise<void> }
  | undefined {
  const desktop = window.openfrontDesktop as
    | { showLinkGate?: unknown }
    | undefined;
  return typeof desktop?.showLinkGate === "function"
    ? (desktop as { showLinkGate: () => Promise<void> })
    : undefined;
}

@customElement("account-modal")
export class AccountModal extends BaseModal {
  protected routerName = "account";

  @state() private email: string = "";
  @state() private isLoadingUser: boolean = false;
  // Set on CrazyGames when a CrazyGames user is signed in. Their identity comes
  // from the SDK, not our backend user object.
  @state() private crazyGamesUser: CrazyGamesUser | null = null;
  @state() private consentBusy: boolean = false;

  private userMeResponse: UserMeResponse | null = null;
  private statsTree: PlayerStatsTree | null = null;
  // Preserves the Games tab's accumulated list + cursor across tab switches.
  private gameHistoryCache: PlayerGameHistoryCache | null = null;
  private gamesScrollTop = 0;
  private restoreGamesScrollAfterOpen = false;
  private cosmetics: Cosmetics | null = null;

  constructor() {
    super();

    document.addEventListener("userMeResponse", (event: Event) => {
      // A CrazyGames sign-in fires userMeResponse (via Main's auth listener);
      // re-fetch the SDK profile so the modal leaves the sign-in screen.
      this.refreshCrazyGamesUser();
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const previousPublicId = this.userMeResponse?.player?.publicId;
        this.userMeResponse = customEvent.detail as UserMeResponse;
        // Reset whenever the player identity changes (login, or switching to a
        // different account) so stats/history from the previous player don't
        // linger.
        if (this.userMeResponse?.player?.publicId !== previousPublicId) {
          this.resetPlayerData();
          this.requestUpdate();
        }
      } else {
        this.resetPlayerData();
        this.requestUpdate();
      }
    });
  }

  // Refresh the signed-in CrazyGames identity from the SDK. No-op off
  // CrazyGames; drives isLinkedAccount() so the modal shows the profile.
  private refreshCrazyGamesUser() {
    if (!crazyGamesSDK.isOnCrazyGames()) return;
    void crazyGamesSDK.getUserProfile().then((user) => {
      this.crazyGamesUser = user;
      this.requestUpdate();
    });
  }

  private hasAnyStats(): boolean {
    if (!this.statsTree) return false;
    // Check if statsTree has any data
    return (
      Object.keys(this.statsTree).length > 0 &&
      Object.values(this.statsTree).some(
        (gameTypeStats) =>
          gameTypeStats && Object.keys(gameTypeStats).length > 0,
      )
    );
  }

  protected renderHeaderSlot() {
    const isLoggedIn = !!this.userMeResponse?.user;
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    return modalHeader({
      title: translateText("account_modal.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
      rightContent:
        isLoggedIn && !this.isLoadingUser && publicId
          ? html`
              <copy-button
                class="shrink-0"
                .copyText=${playerProfileUrl(publicId)}
                .displayText=${translateText("player_profile.share")}
                .showVisibilityToggle=${false}
              ></copy-button>
            `
          : undefined,
    });
  }

  private isLinkedAccount(): boolean {
    // The CrazyGames identity only counts once the backend token exchange
    // produced a session — otherwise a failed exchange would show a dead
    // "connected as" view with no way to retry.
    return (
      hasLinkedIdentity(this.userMeResponse?.user) ||
      (!!this.crazyGamesUser && this.userMeResponse !== null)
    );
  }

  protected modalConfig() {
    if (this.isLoadingUser || !this.isLinkedAccount()) {
      return {};
    }
    return {
      tabs: [
        { key: "account", label: translateText("account_modal.tab_account") },
        { key: "stats", label: translateText("account_modal.tab_stats") },
        { key: "games", label: translateText("account_modal.tab_games") },
        { key: "friends", label: translateText("account_modal.tab_friends") },
        { key: "settings", label: translateText("account_modal.tab_settings") },
      ],
    };
  }

  protected renderBody(tab: string) {
    if (this.isLoadingUser) {
      return this.renderLoadingSpinner(
        translateText("account_modal.fetching_account"),
      );
    }
    if (!this.isLinkedAccount()) {
      return html`<div class="custom-scrollbar mr-1">
        ${crazyGamesSDK.isOnCrazyGames()
          ? this.renderCrazyGamesSignIn()
          : this.renderLoginOptions()}
      </div>`;
    }
    return html`
      <div class="custom-scrollbar mr-1">
        <div class="p-6">${this.renderTab(tab)}</div>
      </div>
    `;
  }

  private renderTab(tab: string): TemplateResult {
    switch (tab) {
      case "stats":
        return this.renderStatsTab();
      case "games":
        return this.renderGamesTab();
      case "friends":
        return this.renderFriendsTab();
      case "settings":
        return this.renderSettingsTab();
      default:
        return this.renderAccountTab();
    }
  }

  // Persistent marketing-consent control (client-driven consent). Mirrors the
  // post-login toast: a player can turn email updates on/off any time here, or
  // — when there's no verified email on the account — is told to link one.
  private renderSettingsTab(): TemplateResult {
    const consent = this.userMeResponse?.player?.marketingConsent;
    // The API didn't return consent state (older backend). The tab is always
    // shown, but with nothing to configure it stays empty rather than showing
    // a misleading "link an email" prompt.
    if (!consent) return html``;
    const hasEmail = consent.hasEmail;
    const on = consent.consented === "approved";
    return html`
      <div class="bg-white/5 rounded-xl border border-white/10 p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="text-white font-medium">
              ${translateText("account_modal.marketing_title")}
            </div>
            <div class="text-white/50 text-sm mt-1">
              ${hasEmail
                ? translateText("account_modal.marketing_desc")
                : translateText("account_modal.marketing_no_email")}
            </div>
          </div>
          ${hasEmail
            ? html`<button
                role="switch"
                aria-checked=${on ? "true" : "false"}
                aria-label=${translateText("account_modal.marketing_title")}
                ?disabled=${this.consentBusy}
                @click=${() => this.setConsent(!on)}
                class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-frontline-red-hover/50 disabled:opacity-60 ${on
                  ? "bg-frontline-red-dim shadow-[var(--shadow-frontline-red)]"
                  : "bg-white/15"}"
              >
                <span
                  class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${on
                    ? "translate-x-6"
                    : "translate-x-1"}"
                ></span>
              </button>`
            : nothing}
        </div>
        ${hasEmail ? nothing : this.renderEmailBinding()}
      </div>
    `;
  }

  // No verified email on the account yet. Offer a magic link to a plain
  // email (the backend associates a not-yet-registered email with the
  // current session — the "new-association" path). Reuses the login form's
  // email field/handlers.
  private renderEmailBinding(): TemplateResult {
    return html`<div class="mt-4 space-y-3">${this.renderEmailField()}</div>`;
  }

  // Shared email input + "get magic link" button, used by both the sign-in form
  // and the Account Settings bind-an-email state so their styling and handlers
  // stay in sync.
  private renderEmailField(): TemplateResult {
    return html`
      <input
        type="email"
        .value=${this.email}
        @input=${this.handleEmailInput}
        placeholder=${translateText("account_modal.email_placeholder")}
        class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-frontline-red-hover/50 focus:border-frontline-red-hover/50 transition-all font-medium hover:bg-white/10"
      />
      <o-button
        variant="brand"
        width="block"
        size="md"
        translationKey="account_modal.get_magic_link"
        @click=${this.handleSubmit}
      ></o-button>
    `;
  }

  private async setConsent(consented: boolean): Promise<void> {
    const consent = this.userMeResponse?.player?.marketingConsent;
    if (!consent || this.consentBusy) return;
    const previous = consent.consented;
    const next = consented ? "approved" : "denied";
    if (previous === next) return;

    // Optimistic: reflect the new state immediately, revert if the request fails.
    this.consentBusy = true;
    consent.consented = next;
    this.requestUpdate();

    const ok = await setMarketingConsent(consented);
    if (!ok) {
      consent.consented = previous;
    }
    this.consentBusy = false;
    this.requestUpdate();
  }

  private renderFriendsTab(): TemplateResult {
    const myPublicId = this.userMeResponse?.player?.publicId ?? "";
    return html`<friends-list
      .myPublicId=${myPublicId}
      @view-profile=${(e: CustomEvent<{ publicId: string }>) =>
        this.openPlayerProfile(e.detail.publicId)}
    ></friends-list>`;
  }

  private openPlayerProfile(publicId: string): void {
    const profileModal = document.querySelector<
      HTMLElement & { openFromAccount(publicId: string): void }
    >("player-profile-modal");
    profileModal?.openFromAccount(publicId);
  }

  public returnToFriends(): void {
    this.open({ tab: "friends" });
  }

  private renderAccountTab(): TemplateResult {
    if (this.crazyGamesUser) {
      return this.renderCrazyGamesAccount(this.crazyGamesUser);
    }
    return html`
      <div class="flex flex-col gap-6">
        <div
          class="relative overflow-hidden rounded-xl border border-white/10 bg-gradient-to-b from-frontline-red-dim/15 to-white/5 p-6"
        >
          <div
            class="pixel-rule absolute top-0 left-0 right-0 opacity-60"
          ></div>
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-frontline-red-hover uppercase tracking-widest font-bold pb-2"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex items-center gap-8 justify-center flex-wrap">
              <discord-user-header
                .data=${this.userMeResponse?.user?.discord ?? null}
              ></discord-user-header>
              ${this.renderLoggedInAs()}
            </div>
          </div>
        </div>
        ${this.renderUsernamePanel()} ${this.renderRewardsPanel()}
        ${this.renderSubscriptionPanel()} ${this.renderDesktopLinkGateAction()}
      </div>
    `;
  }

  // Re-entry to the desktop shell's account-linking gate shown at first
  // launch. Absent entirely on plain web (no window.openfrontDesktop there),
  // present whenever the desktop bridge exposes a callable showLinkGate —
  // see desktopLinkGateBridge() above for why the guard is scoped that way.
  // Needed because the desktop app's menu bar will eventually be hidden and
  // the game runs fullscreen borderless, so a dismissed or since-linked
  // player needs another way back to that gate.
  private renderDesktopLinkGateAction(): TemplateResult | typeof nothing {
    if (!desktopLinkGateBridge()) return nothing;
    return html`
      <o-button
        variant="secondary"
        width="block"
        size="md"
        translationKey="account_modal.link_existing_account"
        @click=${this.handleShowLinkGate}
      ></o-button>
    `;
  }

  private handleShowLinkGate(): void {
    // The bare `void` form swallowed a rejection into an unhandled promise.
    // This is an IPC round trip to the Electron main process, so it can
    // genuinely reject (no window, a main-process throw); catching keeps the
    // failure visible in the console instead of surfacing as a button that
    // silently does nothing.
    desktopLinkGateBridge()
      ?.showLinkGate()
      .catch((err) => {
        console.error("AccountModal: showLinkGate failed", err);
      });
  }

  // CrazyGames "connected as" view: avatar + username from the SDK, plus
  // currency/subscription. No Discord/Google/email link or logout (CrazyGames
  // owns the account and its logout).
  private renderCrazyGamesAccount(user: CrazyGamesUser): TemplateResult {
    return html`
      <div class="flex flex-col gap-6">
        <div
          class="relative overflow-hidden rounded-xl border border-white/10 bg-gradient-to-b from-frontline-red-dim/15 to-white/5 p-6"
        >
          <div
            class="pixel-rule absolute top-0 left-0 right-0 opacity-60"
          ></div>
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-frontline-red-hover uppercase tracking-widest font-bold pb-2"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex flex-col items-center gap-3">
              <div
                class="p-[3px] rounded-full bg-frontline-red-dim shadow-[var(--shadow-frontline-red)]"
              >
                <img
                  src=${user.profilePictureUrl}
                  alt=${user.username}
                  class="w-14 h-14 rounded-full object-cover block"
                  referrerpolicy="no-referrer"
                />
              </div>
              <div class="text-white text-lg font-bold">${user.username}</div>
              ${this.renderCurrency()}
            </div>
          </div>
        </div>
        ${this.renderUsernamePanel()} ${this.renderRewardsPanel()}
        ${this.renderSubscriptionPanel()}
      </div>
    `;
  }

  // Shown when a CrazyGames guest opens the modal: hand off to CrazyGames' own
  // sign-in prompt (no Discord/Google/email on CrazyGames).
  private renderCrazyGamesSignIn(): TemplateResult {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8 text-center"
        >
          <p class="text-white/50 text-sm font-medium mb-6">
            ${translateText("account_modal.sign_in_desc")}
          </p>
          <o-button
            variant="brand"
            width="block"
            size="md"
            translationKey="main.sign_in"
            @click=${this.handleCrazyGamesSignIn}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderStatsTab(): TemplateResult {
    if (!this.hasAnyStats()) {
      return this.renderEmptyState(
        "📊",
        translateText("account_modal.no_stats"),
      );
    }
    return html`
      <player-stats-tree-view
        .statsTree=${this.statsTree}
      ></player-stats-tree-view>
    `;
  }

  private renderGamesTab(): TemplateResult {
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    if (!publicId) {
      return this.renderEmptyState(
        "🎮",
        translateText("account_modal.no_games"),
      );
    }
    return html`
      <player-game-history-view
        .publicId=${publicId}
        .cachedState=${this.gameHistoryCache?.publicId === publicId
          ? this.gameHistoryCache
          : null}
        @history-updated=${(e: CustomEvent<PlayerGameHistoryCache>) => {
          this.gameHistoryCache = e.detail;
        }}
        @view-stats=${(e: CustomEvent<{ gameId: string }>) =>
          this.openGameStats(e.detail.gameId)}
        @view-game=${(e: CustomEvent<{ gameId: string }>) =>
          void this.viewGame(e.detail.gameId)}
      ></player-game-history-view>
    `;
  }

  private renderEmptyState(icon: string, message: string): TemplateResult {
    return html`
      <div
        class="bg-white/5 rounded-xl border border-white/10 p-12 flex flex-col items-center justify-center text-center"
      >
        <div class="text-4xl mb-3">${icon}</div>
        <p class="text-white/60 text-sm">${message}</p>
      </div>
    `;
  }

  // Account-username management (custom-usernames). Hidden when the API
  // doesn't return the username fields yet (older backend).
  private renderUsernamePanel(): TemplateResult | "" {
    const player = this.userMeResponse?.player;
    if (!player || player.usernameStatus === undefined) return "";
    return html`<username-panel .player=${player}></username-panel>`;
  }

  private renderRewardsPanel(): TemplateResult | "" {
    const rewards = this.userMeResponse?.player?.rewards ?? [];
    if (rewards.length === 0) return "";
    return html`<rewards-panel
      .rewards=${rewards}
      @rewards-changed=${this.handleRewardsChanged}
    ></rewards-panel>`;
  }

  // A claim moved unclaimed rewards into the balances; both were returned by
  // the claim endpoint, so update in place instead of re-fetching /users/@me.
  private handleRewardsChanged = (
    event: CustomEvent<RewardsChangedDetail>,
  ): void => {
    if (!this.userMeResponse) return;
    this.userMeResponse.player.rewards = event.detail.rewards;
    if (event.detail.currency) {
      this.userMeResponse.player.currency = event.detail.currency;
    }
    this.requestUpdate();
  };

  private renderSubscriptionPanel(): TemplateResult | "" {
    const sub = this.userMeResponse?.player?.subscription;
    if (!sub) return "";
    const cosmetic = this.cosmetics?.subscriptions?.[sub.tier] ?? null;
    return html`<subscription-panel
      .sub=${sub}
      .cosmetic=${cosmetic}
    ></subscription-panel>`;
  }

  private renderCurrency(): TemplateResult {
    const currency = this.userMeResponse?.player?.currency;
    if (!currency) return html``;

    return html`
      <currency-display
        .hard=${currency.hard}
        .soft=${currency.soft}
      ></currency-display>
    `;
  }

  private renderLoggedInAs(): TemplateResult {
    const me = this.userMeResponse?.user;
    if (me?.discord) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          ${this.renderCurrency()} ${this.renderLogoutButton()}
        </div>
      `;
    } else if (me?.google) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.google.email,
            })}
          </div>
          ${this.renderCurrency()} ${this.renderLogoutButton()}
        </div>
      `;
    } else if (me?.email) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.email,
            })}
          </div>
          ${this.renderCurrency()} ${this.renderLogoutButton()}
        </div>
      `;
    }
    return html``;
  }

  private async viewGame(gameId: string): Promise<void> {
    this.close();
    const encodedGameId = encodeURIComponent(gameId);
    const newUrl = `/${ClientEnv.workerPath(gameId)}/game/${encodedGameId}`;

    history.pushState({ join: gameId }, "", newUrl);
    window.dispatchEvent(
      new CustomEvent("join-changed", { detail: { gameId: encodedGameId } }),
    );
  }

  private openGameStats(gameId: string): void {
    this.gamesScrollTop = this.modalEl?.getScrollTop() ?? 0;
    const statsModal = document.querySelector<
      HTMLElement & { openFromAccount(gameId: string): void }
    >("game-stats-modal");
    statsModal?.openFromAccount(gameId);
  }

  public returnToGames(): void {
    this.restoreGamesScrollAfterOpen = true;
    this.open({ tab: "games" });
  }

  private async restoreGamesScroll(): Promise<void> {
    await this.updateComplete;
    await this.modalEl?.updateComplete;
    const historyView = this.querySelector<
      HTMLElement & { updateComplete?: Promise<boolean> }
    >("player-game-history-view");
    await historyView?.updateComplete;
    this.modalEl?.setScrollTop(this.gamesScrollTop);
  }

  private finishLoadingUser(): void {
    this.isLoadingUser = false;
    this.requestUpdate();
    if (this.restoreGamesScrollAfterOpen) {
      this.restoreGamesScrollAfterOpen = false;
      void this.restoreGamesScroll();
    }
  }

  private resetPlayerData(): void {
    this.statsTree = null;
    this.gameHistoryCache = null;
    this.gamesScrollTop = 0;
    this.restoreGamesScrollAfterOpen = false;
  }

  private renderLogoutButton(): TemplateResult {
    return html`
      <o-button
        variant="danger"
        size="md"
        translationKey="account_modal.log_out"
        @click=${this.handleLogout}
      ></o-button>
    `;
  }

  private renderLoginOptions() {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8"
        >
          <div class="text-center mb-8">
            <div
              class="w-16 h-16 bg-gradient-to-br from-frontline-red-dim/25 to-frontline-red/10 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-inner"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="w-8 h-8 text-frontline-red-hover"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                <polyline points="10 17 15 12 10 7"></polyline>
                <line x1="15" y1="12" x2="3" y2="12"></line>
              </svg>
            </div>
            <p class="text-white/50 text-sm font-medium">
              ${translateText("account_modal.sign_in_desc")}
            </p>
            ${this.renderCurrency()}
          </div>

          <div class="space-y-6">
            <!-- Discord Login Button -->
            <button
              @click="${this.handleDiscordLogin}"
              class="w-full px-6 py-4 text-white bg-[#5865F2] hover:bg-[#4752C4] border border-transparent rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#5865F2] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg hover:shadow-[#5865F2]/20"
            >
              <img
                src=${assetUrl("images/DiscordLogo.svg")}
                alt="Discord"
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${translateText("main.login_discord") ||
                translateText("account_modal.link_discord")}</span
              >
            </button>

            <!-- Google Login Button (Google brand guidelines: white surface,
                 dark text, the multicolor "G" mark) -->
            <button
              @click="${this.handleGoogleLogin}"
              class="w-full px-6 py-4 text-[#1f1f1f] bg-white hover:bg-[#f7f8f8] border border-[#dadce0] rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4285F4] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg"
            >
              <img
                src=${assetUrl("images/GoogleLogo.svg")}
                alt=${translateText("account_modal.google_alt")}
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${translateText("main.login_google")}</span
              >
            </button>

            <!-- Divider -->
            <div class="flex items-center gap-4 py-2">
              <div class="h-px bg-white/10 flex-1"></div>
              <span
                class="text-[10px] uppercase tracking-widest text-white/30 font-bold"
              >
                ${translateText("account_modal.or")}
              </span>
              <div class="h-px bg-white/10 flex-1"></div>
            </div>

            <!-- Email Recovery -->
            <div class="space-y-3">${this.renderEmailField()}</div>
          </div>

          <div class="mt-8 text-center border-t border-white/10 pt-6">
            <button
              @click="${this.handleLogout}"
              class="text-[10px] font-bold text-white/20 hover:text-red-400 transition-colors uppercase tracking-widest pb-0.5"
            >
              ${translateText("account_modal.clear_session")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private handleEmailInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.email = target.value;
  }

  private async handleSubmit() {
    if (!this.email) {
      showToast(translateText("account_modal.enter_email_address"), "error");
      return;
    }

    const success = await sendMagicLink(this.email);
    if (success) {
      showToast(
        translateText("account_modal.recovery_email_sent", {
          email: this.email,
        }),
      );
    } else {
      showToast(
        translateText("account_modal.failed_to_send_recovery_email"),
        "error",
      );
    }
  }

  // CrazyGames sign-in: after their prompt completes, exchange the new token
  // for a session and refresh the modal so it shows the signed-in profile.
  private async handleCrazyGamesSignIn() {
    await crazyGamesSDK.showAuthPrompt();
    const profile = await crazyGamesSDK.getUserProfile();
    if (!profile) return; // prompt cancelled / still not signed in
    invalidateUserMe();
    await reauthAfterCrazyGamesChange();
    const userMe = await getUserMe();
    if (userMe) this.userMeResponse = userMe;
    this.crazyGamesUser = profile;
    this.requestUpdate();
  }

  private handleDiscordLogin() {
    discordLogin();
  }

  private handleGoogleLogin() {
    googleLogin();
  }

  protected onOpen(): void {
    this.isLoadingUser = true;

    this.refreshCrazyGamesUser();

    void fetchCosmetics().then((cosmetics) => {
      this.cosmetics = cosmetics;
      this.requestUpdate();
    });

    void getUserMe()
      .then((userMe) => {
        if (userMe) {
          this.userMeResponse = userMe;
          if (this.userMeResponse?.player?.publicId) {
            this.loadPlayerProfile(this.userMeResponse.player.publicId);
          }
        }
        this.finishLoadingUser();
      })
      .catch((err) => {
        console.warn("Failed to fetch user info in AccountModal.open():", err);
        this.finishLoadingUser();
      });
    this.requestUpdate();
  }

  protected onClose(): void {
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  private async handleLogout() {
    await logOut();
    this.close();
    // Refresh the page after logout to update the UI state
    window.location.reload();
  }

  private async loadPlayerProfile(publicId: string): Promise<void> {
    try {
      const data = await fetchPlayerById(publicId);
      if (!data) {
        this.requestUpdate();
        return;
      }

      this.statsTree = data.stats;

      this.requestUpdate();
    } catch (err) {
      console.warn("Failed to load player data:", err);
      this.requestUpdate();
    }
  }
}
