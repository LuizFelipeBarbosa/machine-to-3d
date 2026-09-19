// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import { VersionBar } from './VersionBar';

const draftId = 'draft' as Id<'procedureVersions'>;
const versions = [
  { _id: draftId, version: 3, status: 'draft' as const, _creationTime: 1000 },
  { _id: 'approved' as Id<'procedureVersions'>, version: 2, status: 'approved' as const, _creationTime: 900, changeNote: 'Reviewed' },
  { _id: 'retired' as Id<'procedureVersions'>, version: 1, status: 'retired' as const, _creationTime: 800 },
];

afterEach(cleanup);

describe('version controls', () => {
  it('offers a collapsed agent revision form only for a draft with a revision handler', () => {
    const view = render(createElement(VersionBar, { versions, draftId }));
    expect(screen.queryByText('Revise with agent')).toBeNull();
    expect(screen.queryByLabelText('Revision instruction')).toBeNull();
    const onRevise = vi.fn(async () => {});
    view.rerender(createElement(VersionBar, { versions, draftId, onRevise }));
    expect(screen.getByText('Revise with agent').closest('details')?.open).toBe(false);
    expect(screen.getByLabelText('Revision instruction')).toBeTruthy();
    view.rerender(createElement(VersionBar, { versions: versions.slice(1), onRevise }));
    expect(screen.queryByText('Revise with agent')).toBeNull();
    expect(screen.queryByLabelText('Revision instruction')).toBeNull();
  });

  it('requires a non-blank revision instruction', () => {
    render(createElement(VersionBar, { versions, draftId, onRevise: async () => {} }));
    fireEvent.click(screen.getByText('Revise with agent'));
    const send = screen.getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Revision instruction'), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Revision instruction'), { target: { value: 'Fix the hinge' } });
    expect(send.disabled).toBe(false);
  });

  it('sends the trimmed revision instruction', async () => {
    const onRevise = vi.fn(async () => {});
    render(createElement(VersionBar, { versions, draftId, onRevise }));
    fireEvent.click(screen.getByText('Revise with agent'));
    fireEvent.change(screen.getByLabelText('Revision instruction'), { target: { value: '  The door hinges on the left  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(onRevise).toHaveBeenCalledExactlyOnceWith('The door hinges on the left'));
    expect((screen.getByLabelText('Revision instruction') as HTMLTextAreaElement).value).toBe('');
  });

  it('requires a second click to discard and keeps approval hidden for authors', async () => {
    const onDiscard = vi.fn(async () => {});
    render(createElement(VersionBar, { versions, draftId, status: 'unsaved', onDiscard }));
    expect(screen.getByText('Draft v3')).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Really discard?' }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce());
  });

  it('collects a change note and renders Convex validation errors inline', async () => {
    const onApprove = vi.fn(async () => { throw new ConvexError('Invalid procedure references:\nUnknown part'); });
    render(createElement(VersionBar, { versions, draftId, canApprove: true, onApprove }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Change note'), { target: { value: ' Updated instructions ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unknown part');
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('Updated instructions');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Change note')).toBeNull();
  });

  it('offers approved and retired sources only when no draft exists', async () => {
    const onCreateDraft = vi.fn(async () => {});
    const view = render(createElement(VersionBar, { versions: versions.slice(1), onCreateDraft }));
    fireEvent.click(screen.getByRole('button', { name: 'New draft from v1' }));
    await waitFor(() => expect(onCreateDraft).toHaveBeenLastCalledWith('retired'));
    fireEvent.click(screen.getByRole('button', { name: 'New draft from v2' }));
    await waitFor(() => expect(onCreateDraft).toHaveBeenLastCalledWith('approved'));
    view.rerender(createElement(VersionBar, { versions, draftId, onCreateDraft }));
    expect(screen.queryByRole('button', { name: /New draft from/ })).toBeNull();
    view.rerender(createElement(VersionBar, { versions: [], onCreateDraft }));
    fireEvent.click(screen.getByRole('button', { name: 'Start a draft' }));
    await waitFor(() => expect(onCreateDraft).toHaveBeenLastCalledWith());
  });
});
