import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveCompactAtTokens, loadConfig } from "../src/config.js";

describe("effectiveCompactAtTokens", () => {
	const base = { compactAtContextTokens: 320_000, compactAtWindowFraction: 0.7 };

	it("returns the configured absolute when the window is unknown or invalid", () => {
		expect(effectiveCompactAtTokens(base)).toBe(320_000);
		expect(effectiveCompactAtTokens(base, 0)).toBe(320_000);
		expect(effectiveCompactAtTokens(base, -1)).toBe(320_000);
		expect(effectiveCompactAtTokens(base, Number.NaN)).toBe(320_000);
	});

	it("keeps the configured absolute when it sits below the window cap (512k)", () => {
		// 0.7 * 512k = 358,400 > 320,000, so the 512k-tuned absolute binds.
		expect(effectiveCompactAtTokens(base, 512_000)).toBe(320_000);
	});

	it("caps by the window fraction on smaller windows", () => {
		expect(effectiveCompactAtTokens(base, 200_000)).toBe(140_000);
		expect(effectiveCompactAtTokens(base, 128_000)).toBe(89_600);
	});

	it("always fires before pi's own threshold (window - reserveTokens, reserve default 16,384)", () => {
		const reserveTokens = 16_384;
		for (const window of [64_000, 128_000, 200_000, 256_000, 512_000, 1_000_000]) {
			expect(effectiveCompactAtTokens(base, window)).toBeLessThan(window - reserveTokens);
		}
	});

	it("caps at the window itself when the fraction is 1", () => {
		const config = { compactAtContextTokens: 10_000_000, compactAtWindowFraction: 1 };
		expect(effectiveCompactAtTokens(config, 512_000)).toBe(512_000);
	});

	it("never raises the configured absolute", () => {
		const small = { compactAtContextTokens: 50_000, compactAtWindowFraction: 0.7 };
		expect(effectiveCompactAtTokens(small, 1_000_000)).toBe(50_000);
	});
});

describe("loadConfig — 512k defaults and the window-fraction cap", () => {
	let dir: string;
	let cwd: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-config-"));
		cwd = join(dir, "project");
		mkdirSync(cwd, { recursive: true });
		// Isolate the global settings file (~/.pi/agent/settings.json).
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	function writeProjectSettings(value: unknown): void {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": value }));
	}

	it("ships 512k-tuned defaults", () => {
		const config = loadConfig(cwd);
		expect(config.chunkTokens).toBe(15_000);
		expect(config.chunkOverlapTokens).toBe(0);
		expect(config.poolTargetTokens).toBe(30_000);
		expect(config.consolidateAtPoolTokens).toBe(50_000);
		expect(config.compactAtContextTokens).toBe(320_000);
		expect(config.compactAtWindowFraction).toBe(0.7);
		expect(config.tailTokens).toBe(40_000);
		expect(config.journeyTargetTokens).toBe(4_000);
		expect(config.observerConcurrency).toBe(6);
	});

	it("accepts a fractional compactAtWindowFraction from project settings", () => {
		writeProjectSettings({ compactAtWindowFraction: 0.5 });
		expect(loadConfig(cwd).compactAtWindowFraction).toBe(0.5);
	});

	it("ignores out-of-range or non-numeric fractions", () => {
		for (const bad of [0, -0.1, 1.5, "0.5", null, true]) {
			writeProjectSettings({ compactAtWindowFraction: bad });
			expect(loadConfig(cwd).compactAtWindowFraction).toBe(0.7);
		}
	});
});
