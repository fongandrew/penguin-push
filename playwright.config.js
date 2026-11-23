import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 2 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:3000',
		trace: 'off',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// The static site, plus the netplay relay (Node adapter synced from
	// pomelo-penguin) for the two-browser multiplayer spec.
	webServer: [
		{
			command: 'npm run dev',
			url: 'http://localhost:3000',
			reuseExistingServer: !process.env['CI'],
			stdout: 'ignore',
			stderr: 'pipe',
		},
		{
			command: 'npm run dev:relay',
			url: 'http://127.0.0.1:8788/health',
			reuseExistingServer: !process.env['CI'],
			stdout: 'ignore',
			stderr: 'pipe',
		},
	],
});
