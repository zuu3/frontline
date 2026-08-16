import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { claimReward, getUserMe, invalidateUserMe } from "./Api";
import { BaseModal } from "./components/BaseModal";
import "./components/CapIcon";
import { modalHeader } from "./components/ui/ModalHeader";
import { updateCheckinStreakBadge } from "./NavCheckinBadge";
import { translateText } from "./Utils";
import { DAILY_CHECKIN_SCHEDULE, dailyCheckinCycleDay } from "../core/DailyCheckin";
import type { Reward } from "../core/ApiSchemas";

@customElement("checkin-modal")
export class CheckinModal extends BaseModal {
  protected routerName = "checkin";

  @state() private streak = 0;
  @state() private pendingReward: Reward | null = null;
  @state() private loading = true;
  @state() private claiming = false;

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("checkin.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected onOpen(): void {
    this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    // This page is a viewer/claimer only -- it never advances the streak
    // itself. The streak only advances from playing a game (any result; see
    // grantDailyCheckinIfEligible's call site in /game/:gameId,
    // AuthServer.ts). getUserMe() caches /users/@me until invalidated (see
    // Api.ts); Main.ts's initial load may have cached this before the most
    // recent game finished, so it's dropped here to guarantee a fresh read.
    invalidateUserMe();
    const me = await getUserMe();
    if (me !== false) {
      this.streak = me.player.dailyCheckin?.streak ?? 0;
      this.pendingReward =
        me.player.rewards?.find((r) => r.reason === "daily_checkin") ?? null;
      updateCheckinStreakBadge(this.streak);
    }
    this.loading = false;
  }

  private async onClaim(): Promise<void> {
    if (!this.pendingReward || this.claiming) return;
    this.claiming = true;
    const result = await claimReward(this.pendingReward.id);
    this.claiming = false;
    if (result !== false && result !== "not_found") {
      invalidateUserMe();
      this.pendingReward = null;
      this.requestUpdate();
    }
  }

  private renderDay(day: number): TemplateResult {
    // The current cycle day only lines up with `day` while today's reward
    // is still unclaimed; once claimed, streak has already advanced past it
    // (see grantDailyCheckinIfEligible), so "today" reads as the most
    // recently completed cell instead -- still the right visual anchor.
    const cycleDay = this.streak > 0 ? dailyCheckinCycleDay(this.streak) : 0;
    const isToday = day === cycleDay && this.pendingReward !== null;
    const isDone = this.streak > 0 && (day < cycleDay || (day === cycleDay && !this.pendingReward));
    const amount = DAILY_CHECKIN_SCHEDULE[day - 1];
    return html`
      <div
        class="flex flex-col items-center gap-1 rounded-lg px-2 py-3 flex-1 min-w-0 border ${isToday
          ? "border-frontline-red-hover bg-frontline-red-dim/20"
          : isDone
            ? "border-white/10 bg-white/5"
            : "border-white/5 bg-transparent"}"
      >
        <span class="text-[11px] uppercase tracking-wider text-white/50">
          ${translateText("checkin.day_label", { day: String(day) })}
        </span>
        <cap-icon .size=${16}></cap-icon>
        <span class="text-sm font-bold ${isDone ? "text-white/40" : "text-white"}">
          ${amount}
        </span>
        ${isDone
          ? html`<span class="text-frontline-red-hover text-xs">✓</span>`
          : ""}
      </div>
    `;
  }

  protected renderBody(): TemplateResult {
    if (this.loading) {
      return html`<div class="p-8 text-center text-white/50">
        ${translateText("common.loading")}
      </div>`;
    }
    return html`
      <div class="flex flex-col gap-4 p-6">
        <div class="text-center text-white/70 text-sm">
          ${translateText("checkin.streak_label", {
            streak: String(this.streak),
          })}
        </div>
        <div class="flex gap-2">
          ${Array.from({ length: DAILY_CHECKIN_SCHEDULE.length }, (_, i) =>
            this.renderDay(i + 1),
          )}
        </div>
        <button
          class="w-full rounded-md py-3 font-bold uppercase tracking-wider transition-colors ${this
            .pendingReward
            ? "bg-frontline-red-hover text-white hover:brightness-110 cursor-pointer"
            : "bg-white/5 text-white/30 cursor-default"}"
          ?disabled=${!this.pendingReward || this.claiming}
          @click=${() => this.onClaim()}
        >
          ${this.pendingReward
            ? translateText("checkin.claim_button", {
                amount: String(this.pendingReward.amount),
              })
            : translateText("checkin.claimed_today")}
        </button>
      </div>
    `;
  }
}
