import { describe, expect, it } from "vitest";

import {
  formatSessionLabel,
  renderHelpMessage,
  renderHelpTopicMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains all command groups", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Beszélgetés");
      expect(html).toContain("Modell");
      expect(html).toContain("Hitelesítés");
      expect(html).toContain("Segédeszközök");
      expect(plain).toContain("/new");
      expect(plain).toContain("/projekts");
      expect(plain).toContain("/help");
      expect(plain).toContain("/retry");
      expect(plain).toContain("/launch_profiles");
      expect(plain).toContain("/handoff_to");
    });

    it("lists all 19 commands", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/\/\w+/g) ?? [];
      expect(commandMatches.length).toBe(19);
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderHelpTopicMessage", () => {
    it("explains the attach handoff flow", () => {
      const { plain } = renderHelpTopicMessage("attach");
      expect(plain).toContain("/attach <thread-id>");
      expect(plain).toContain("Thread ID");
      expect(plain).toContain("/session");
    });

    it("explains the handback flow", () => {
      const { plain } = renderHelpTopicMessage("handback");
      expect(plain).toContain("/handback");
      expect(plain).toContain("codex resume <thread-id>");
      expect(plain).toContain("Telegramon addig folytatott beszélgetést");
    });

    it("accepts the common hangback typo as an alias", () => {
      const { plain } = renderHelpTopicMessage("hangback");
      expect(plain).toContain("/handback");
    });

    it("returns topic suggestions for unknown topics", () => {
      const { plain } = renderHelpTopicMessage("nincsilyen");
      expect(plain).toContain("Nincs ilyen részletes súgó");
      expect(plain).toContain("attach");
      expect(plain).toContain("handback");
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("AttysCodexBridge készen áll");
      expect(plain).toContain("/help");
      expect(html).not.toContain("⚠️");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("⚠️");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>Thread:</b> abc123",
        "Thread: abc123",
        false,
      );
      expect(html).toContain("AttysCodexBridge");
      expect(html).toContain("abc123");
      expect(plain).toContain("abc123");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("téma szál");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("⚠️");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("formats basic session label", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("📁");
      expect(label).toContain("my-project");
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
    });

    it("shows checkmark for active session", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("✅");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("truncates long workspace names to 12 chars", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("my-very-lon…");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(cím nélkül)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label).toContain("very-long…");
    });
  });
});
