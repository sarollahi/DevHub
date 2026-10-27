import { test, expect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Enterprise repository user journeys", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000/login");
    await page.getByLabel("Email address").fill("ahmad.sarollahi@gmail.com");
    await page.getByLabel("Password").fill(process.env.BOOTSTRAP_USER_PASSWORD);
    const submitted = page.waitForResponse(response => response.url().endsWith("/api/auth/login"));
    await page.getByRole("button", { name: /Continue to workspace/i }).click();
    const login = await submitted;
    if (login.status() >= 400) throw Error("Browser sign-in rejected: HTTP " + login.status() + " " + (await login.text()).slice(0,200));
    await expect(page).toHaveURL(/\/repositories/);
  });
  async function openRepository(page) {
    await page.getByRole("link", { name: "Open source-control workspace" }).first().click();
    await expect(page).toHaveURL(/\/browse/);
  }
  test("browse, source lines, history, blame and paginated code", async ({ page }) => {
    await openRepository(page);
    await expect(page.getByRole("link", { name: "README.md" })).toBeVisible();
    await page.getByRole("link", { name: "src" }).click();
    await expect(page.getByRole("link", { name: "hello.ts" })).toBeVisible();
    await expect(page.getByText("secret.ts")).toHaveCount(0);
    await page.getByRole("link", { name: "hello.ts" }).click();
    await expect(page.getByRole("region", { name: "File contents" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next lines" })).toBeVisible();
    await page.getByRole("link", { name: "Next lines" }).click();
    await expect(page.locator("#L181")).toBeVisible();
    await page.getByRole("link", { name: "Blame" }).click();
    await expect(page.getByRole("region", { name: "File blame" })).toBeVisible();
    await page.getByRole("link", { name: "File history" }).click();
    await expect(page.getByRole("table")).toContainText("Extend greeting");
  });
  test("native search excludes unreferenced objects and rejects unauthenticated access", async ({ page }) => {
    await openRepository(page);
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Search" }).click();
    await page.getByLabel("Search this repository").fill("hello");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("table")).toContainText("src/hello.ts");
    const repositoryId = new URL(page.url()).pathname.split("/")[2];
    const guest = await request.newContext();
    const denied = await guest.get("http://localhost:3000/api/v2/repositories/" + repositoryId + "/search?q=hello&mode=path");
    expect(denied.status()).toBe(401);
    await guest.dispose();
    await page.getByLabel("Search this repository").fill("internal-only");
    await page.getByLabel("In").selectOption("content");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("No matching indexed files")).toBeVisible();
    await page.getByLabel("Search this repository").fill("Hello DevHub");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("table")).toContainText("src/hello.ts");
  });
  test("revision comparison and persisted reviews, agents, settings", async ({ page }) => {
    await openRepository(page);
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "History" }).click();
    const hrefs = await page.locator("table tbody tr td:last-child a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(1);
    const baseRevision = new URL(hrefs[1], "http://localhost:3000").searchParams.get("revision");
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Compare" }).click();
    await page.getByLabel("Base revision").fill(baseRevision);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page.getByText("changed files")).toBeVisible();
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Reviews" }).click();
    await expect(page.getByRole("table")).toContainText("Extend greeting");
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Agents" }).click();
    await expect(page.getByText("Repository delegations")).toBeVisible();
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("Default branch")).toBeVisible();
  });
  test("keyboard access, critical accessibility and navigation performance", async ({ page }) => {
    await openRepository(page);
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(["A", "BUTTON", "INPUT", "SELECT"]).toContain(focused);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(accessibility.violations.filter(v => v.impact === "critical")).toEqual([]);
    const navDuration = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.duration ?? 0);
    expect(navDuration).toBeLessThan(10000);
  });
});
