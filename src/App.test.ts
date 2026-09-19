// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./data/mode', () => ({ isConvexMode: false, convexUrl: undefined }));
vi.mock('./scene', () => ({ MachineScene: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens machine administration in local mode without an auth or Convex provider', () => {
  window.history.replaceState(null, '', '/admin/machines');
  render(createElement(App));
  expect(screen.getByText('Needs the backend').className).toBe('notice');
  expect(screen.queryByRole('link', { name: 'Machines admin' })).toBeNull();
});

it('browses local machines, the explorer, and a procedure without any auth provider', async () => {
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  Element.prototype.scrollIntoView = vi.fn();
  render(createElement(App));
  expect(screen.getByText('Local demo')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Records' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();

  fireEvent.click(await screen.findByRole('link', { name: 'Park NX10' }));
  const explorer = await screen.findByRole('complementary', { name: 'Explore' });
  expect(window.location.pathname).toBe('/m/park-nx10');
  expect(screen.getByRole('button', { name: 'Reset view' })).toBeTruthy();
  const procedureButton = within(explorer).getByRole('button', { name: /Non-contact topography scan/ });
  fireEvent.click(procedureButton);
  expect(await screen.findByRole('complementary', { name: 'Procedure' })).toBeTruthy();
  expect(window.location.pathname).toMatch(/^\/m\/park-nx10\/[^/]+$/);
  expect(screen.queryByText('Recorded')).toBeNull();
});
