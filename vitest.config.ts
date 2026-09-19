import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'shared/**/*.test.ts',
            'scripts/**/*.test.ts',
            'seed/**/*.test.ts',
            'src/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'convex',
          include: ['convex/**/*.test.ts'],
          environment: 'edge-runtime',
          server: {
            deps: {
              inline: ['convex-test'],
            },
          },
        },
      },
    ],
  },
});
