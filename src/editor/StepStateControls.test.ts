// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateVar } from '../../shared/machine';
import { StepStateControls } from './StepStateControls';

const fraction: StateVar = {
  name: 'lift', label: 'Lift progress', kind: 'fraction',
  effects: [{ type: 'translate', node: 'head', offset: [0, 1, 0] }],
};

afterEach(cleanup);

describe('StepStateControls', () => {
  it.each([undefined, {}])('shows inherited fraction progress when state is %j', (state) => {
    render(createElement(StepStateControls, {
      stateVars: [fraction], state, inherited: { lift: 0.18 }, onChange: vi.fn(),
    }));

    const input = screen.getByRole('spinbutton', { name: 'Lift progress' }) as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.min).toBe('0');
    expect(input.max).toBe('1');
    expect(input.step).toBe('0.01');
    expect(input.valueAsNumber).toBe(0.18);
    expect(screen.getByText('inherits: 0.18')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inherit' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'On' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
  });

  it.each([0, 0.42])('displays an explicit fraction value of %s instead of the inherited value', (value) => {
    render(createElement(StepStateControls, {
      stateVars: [fraction], state: { lift: value }, inherited: { lift: 0.18 }, onChange: vi.fn(),
    }));

    const input = screen.getByRole('spinbutton', { name: 'Lift progress' }) as HTMLInputElement;
    expect(input.valueAsNumber).toBe(value);
    expect(screen.getByRole('button', { name: 'Inherit' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('emits numeric edits, clamps to 0..1, ignores empty input, and allows inheritance', () => {
    const onChange = vi.fn();
    const props = { stateVars: [fraction], inherited: { lift: 0.18 }, onChange };
    const view = render(createElement(StepStateControls, { ...props, state: { lift: 0.42 } }));
    const input = screen.getByRole('spinbutton', { name: 'Lift progress' });

    fireEvent.change(input, { target: { value: '0.63' } });
    expect(onChange).toHaveBeenLastCalledWith('lift', 0.63);
    fireEvent.change(input, { target: { value: '-0.5' } });
    expect(onChange).toHaveBeenLastCalledWith('lift', 0);
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(onChange).toHaveBeenLastCalledWith('lift', 1);

    onChange.mockClear();
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Inherit' }));
    expect(onChange).toHaveBeenCalledWith('lift', null);
    view.rerender(createElement(StepStateControls, { ...props, state: undefined }));
    expect((input as HTMLInputElement).valueAsNumber).toBe(0.18);
  });
});
