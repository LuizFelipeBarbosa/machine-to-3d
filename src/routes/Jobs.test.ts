// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewJob } from './NewJob';
import { JobDetail, Jobs } from './Jobs';

const backend = vi.hoisted(() => ({
  query: vi.fn(), generateUploadUrl: vi.fn(), create: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
  role: 'author', loading: false,
}));

vi.mock('../auth/useMe', () => ({
  useMe: () => ({ me: backend.loading ? undefined : { role: backend.role }, loading: backend.loading }),
}));
vi.mock('convex/react', () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => (
    args === 'skip' ? undefined : backend.query(getFunctionName(reference), args)
  ),
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(reference)) {
      case 'files:generateUploadUrl': return backend.generateUploadUrl;
      case 'draftJobs:create': return backend.create;
      case 'draftJobs:cancel': return backend.cancel;
      case 'draftJobs:retry': return backend.retry;
      default: throw new Error('Unexpected mutation');
    }
  },
}));

const machine = { _id: 'machine-id', slug: 'test-machine', name: 'Test machine', kind: 'Instrument', procedures: [] };
const job = {
  _id: 'job-id', title: 'Start the machine', machineSlug: 'test-machine', procedureSlug: 'start',
  kind: 'create', status: 'running', stage: 'codex', brief: '', attempts: 1,
  _creationTime: 1726747100000, updatedAt: 1726747200000,
};

function app(path = '/jobs/job-id') {
  return createElement(MemoryRouter, { initialEntries: [path] },
    createElement(Routes, null,
      createElement(Route, { path: '/jobs/new', element: createElement(NewJob) }),
      createElement(Route, { path: '/jobs', element: createElement(Jobs) }),
      createElement(Route, { path: '/jobs/:id', element: createElement(JobDetail) }),
    ));
}

function fillForm() {
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: machine._id } });
  fireEvent.change(screen.getByLabelText('Action title'), { target: { value: 'Start the machine' } });
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'Show the controls' } });
  const file = new File(['video'], 'demo.mp4', { type: 'video/mp4' });
  fireEvent.change(screen.getByLabelText('Video'), { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  vi.resetAllMocks();
  backend.role = 'author';
  backend.loading = false;
  backend.query.mockImplementation((name) => {
    if (name === 'machines:list') return [machine];
    if (name === 'draftJobs:get') return job;
    if (name === 'draftJobs:events') return [];
    if (name === 'draftJobs:listMine' || name === 'draftJobs:list') return [job];
    return undefined;
  });
  backend.generateUploadUrl.mockResolvedValue('https://upload.example.test');
  backend.create.mockResolvedValue('job-id');
  backend.cancel.mockResolvedValue(null);
  backend.retry.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: 'video-id' }) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NewJob', () => {
  it('derives the slug as the title changes until the slug is edited directly', () => {
    render(app('/jobs/new'));
    const title = screen.getByLabelText('Action title');
    const slug = screen.getByLabelText('Procedure slug') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '  Start / THE machine!! ' } });
    expect(slug.value).toBe('start-the-machine');
    fireEvent.change(title, { target: { value: 'Stop & clean' } });
    expect(slug.value).toBe('stop-clean');
    fireEvent.change(slug, { target: { value: 'custom-slug' } });
    fireEvent.change(title, { target: { value: 'Another title' } });
    expect(slug.value).toBe('custom-slug');
    fireEvent.change(slug, { target: { value: '' } });
    fireEvent.change(title, { target: { value: 'Still another title' } });
    expect(slug.value).toBe('');
  });

  it('only shows new-machine fields when New machine… is selected', () => {
    render(app('/jobs/new'));
    for (const label of ['Slug', 'Name', 'Kind']) expect(screen.queryByLabelText(label)).toBeNull();
    const select = screen.getByLabelText('Machine');
    const option = screen.getByRole('option', { name: 'New machine…' }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: option.value } });
    for (const label of ['Slug', 'Name', 'Kind']) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByLabelText('Slug').getAttribute('pattern')).toBe('[a-z0-9-]+');
    fireEvent.change(select, { target: { value: machine._id } });
    for (const label of ['Slug', 'Name', 'Kind']) expect(screen.queryByLabelText(label)).toBeNull();
  });

  it('preselects the machine query parameter when machines finish loading', () => {
    backend.query.mockReturnValue(undefined);
    const view = render(app('/jobs/new?machine=test-machine'));
    expect(screen.getByText('Loading machines…')).toBeTruthy();
    backend.query.mockReturnValue([machine]);
    view.rerender(app('/jobs/new?machine=test-machine'));
    expect((screen.getByLabelText('Machine') as HTMLSelectElement).value).toBe(machine._id);
  });

  it('shows the non-author notice instead of a form for trainees', () => {
    backend.role = 'trainee';
    const view = render(app('/jobs/new'));
    expect(screen.getByText('Authors can draft procedures from video.')).toBeTruthy();
    expect(view.container.querySelector('form')).toBeNull();
    expect(backend.query).not.toHaveBeenCalled();
  });

  it('uploads before creating the job, shows each stage, and navigates to its detail', async () => {
    let finishUpload: (value: string) => void = () => {};
    let finishCreate: (value: string) => void = () => {};
    backend.generateUploadUrl.mockReturnValue(new Promise<string>((resolve) => { finishUpload = resolve; }));
    backend.create.mockReturnValue(new Promise<string>((resolve) => { finishCreate = resolve; }));
    render(app('/jobs/new'));
    const file = fillForm();
    const submit = screen.getByRole('button', { name: 'Draft from video' }) as HTMLButtonElement;
    // JSDOM does not update native file-input validity for a synthetic FileList.
    fireEvent.submit(submit.closest('form')!);
    expect(screen.getByRole('status').textContent).toBe('Uploading video…');
    expect(submit.disabled).toBe(true);
    expect(backend.generateUploadUrl).toHaveBeenCalledWith({ kind: 'media' });
    expect(backend.create).not.toHaveBeenCalled();
    await act(async () => finishUpload('https://upload.example.test'));
    expect(fetch).toHaveBeenCalledWith('https://upload.example.test', {
      method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: file,
    });
    expect(screen.getByRole('status').textContent).toBe('Creating job…');
    expect(submit.disabled).toBe(true);
    expect(backend.create).toHaveBeenCalledWith({
      machineId: machine._id, procedureSlug: 'start-the-machine', title: 'Start the machine',
      brief: 'Show the controls', videoFileId: 'video-id',
    });
    await act(async () => finishCreate('job-id'));
    expect(screen.getByRole('heading', { name: job.title })).toBeTruthy();
    expect(backend.query).toHaveBeenCalledWith('draftJobs:get', { jobId: 'job-id' });
  });

  it('submits new-machine metadata instead of an existing machine id', async () => {
    render(app('/jobs/new'));
    fillForm();
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-machine' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New machine' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'Instrument' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Draft from video' }).closest('form')!);
    await waitFor(() => expect(backend.create).toHaveBeenCalledWith({
      newMachine: { slug: 'new-machine', name: 'New machine', kind: 'Instrument' },
      procedureSlug: 'start-the-machine', title: 'Start the machine', brief: 'Show the controls', videoFileId: 'video-id',
    }));
  });

  it.each(['http', 'network', 'invalid-response', 'create'])(
    'reports %s errors and enables resubmission', async (failure) => {
      let message = 'The video could not be uploaded. Please try again.';
      if (failure === 'http') vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      if (failure === 'network') {
        message = 'Network unavailable';
        vi.mocked(fetch).mockRejectedValue(new Error(message));
      }
      if (failure === 'invalid-response') {
        message = 'The upload did not return a file id.';
        vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      }
      if (failure === 'create') {
        message = 'Slug already used';
        backend.create.mockRejectedValue(new ConvexError(message));
      }
      render(app('/jobs/new'));
      fillForm();
      const submit = screen.getByRole('button', { name: 'Draft from video' }) as HTMLButtonElement;
      fireEvent.submit(submit.closest('form')!);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(message);
      expect(alert.className).toBe('notice error');
      expect(submit.disabled).toBe(false);
      if (failure !== 'create') expect(backend.create).not.toHaveBeenCalled();
    },
  );
});

describe('JobDetail', () => {
  it('marks completed, current, and upcoming stages', () => {
    render(app());
    const timeline = within(screen.getByRole('list', { name: 'Job stages' }));
    expect(timeline.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Workspace', 'Extract frames', 'Processing', 'Verify', 'Frame views', 'Upload', 'Done',
    ]);
    expect(timeline.getByText('Workspace').classList.contains('is-done')).toBe(true);
    expect(timeline.getByText('Extract frames').classList.contains('is-done')).toBe(true);
    expect(timeline.getByText('Processing').classList.contains('is-current')).toBe(true);
    expect(timeline.getByText('Processing').getAttribute('aria-current')).toBe('step');
    expect(timeline.getByText('Verify').className).toBe('');
  });

  it('marks the failed stage, renders the error, and retries', async () => {
    backend.query.mockImplementation((name) => name === 'draftJobs:get'
      ? { ...job, status: 'failed', lastError: 'Could not verify\nMissing step' } : []);
    render(app());
    expect(screen.getByText(/Could not verify/).tagName).toBe('PRE');
    expect(screen.getByText(/Could not verify/).className).toBe('job-error');
    expect(screen.getByText('Processing').classList.contains('is-failed')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(backend.retry).toHaveBeenCalledWith({ jobId: 'job-id' }));
  });

  it.each(['queued', 'running'])('can cancel a %s job', async (status) => {
    backend.query.mockImplementation((name) => name === 'draftJobs:get' ? { ...job, status } : []);
    render(app());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledWith({ jobId: 'job-id' }));
  });

  it('reports action errors and restores the action button', async () => {
    backend.cancel.mockRejectedValue(new ConvexError('Job is not active'));
    render(app());
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    fireEvent.click(cancel);
    expect(cancel.disabled).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toBe('Job is not active');
    expect(cancel.disabled).toBe(false);
  });

  it('links to the produced procedure in the editor', () => {
    backend.query.mockImplementation((name) => name === 'draftJobs:get'
      ? { ...job, status: 'done', stage: 'done', producedProcedureVersionId: 'version-id' } : []);
    render(app());
    expect(screen.getByRole('link', { name: 'Open in editor' }).getAttribute('href')).toBe('/m/test-machine/start/edit');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([undefined, false, true])('renders modelChanged=%s correctly', (modelChanged) => {
    backend.query.mockImplementation((name) => name === 'draftJobs:get' ? { ...job, modelChanged } : []);
    render(app());
    if (modelChanged === undefined) expect(screen.queryByText(/^Model:/)).toBeNull();
    else expect(screen.getByText(`Model: ${modelChanged ? 'new draft version' : 'unchanged'}`)).toBeTruthy();
  });

  it('renders live events oldest-first with level classes and updates the timeline', () => {
    const view = render(app());
    expect(backend.query).toHaveBeenCalledWith('draftJobs:events', { jobId: 'job-id' });
    backend.query.mockImplementation((name) => name === 'draftJobs:get' ? { ...job, stage: 'verify' } : [
      { at: 2000, level: 'warn', message: 'Check this' }, { at: 1000, level: 'info', message: 'Started' },
    ]);
    view.rerender(app());
    const events = within(screen.getByRole('list', { name: 'Job events' })).getAllByRole('listitem');
    expect(events[0].textContent).toContain('Started');
    expect(events[0].className).toBe('info');
    expect(events[1].textContent).toContain('Check this');
    expect(events[1].className).toBe('warn');
    expect(screen.getByText('Processing').classList.contains('is-done')).toBe(true);
    expect(screen.getByText('Verify').classList.contains('is-current')).toBe(true);
  });

  it('shows loading and not-found states', () => {
    backend.query.mockReturnValue(undefined);
    const view = render(app());
    expect(screen.getByRole('status').textContent).toBe('Loading job…');
    backend.query.mockReturnValue(null);
    view.rerender(app());
    expect(screen.getByText('Job not found.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('Jobs', () => {
  it.each(['author', 'approver', 'admin'])('renders jobs with the correct query for %s', (role) => {
    backend.role = role;
    render(app('/jobs'));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    const cells = within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual([
      job.title, job.machineSlug, job.procedureSlug, job.kind, 'running (codex)',
      new Date(job.updatedAt).toLocaleString(), 'Open',
    ]);
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/jobs/job-id');
    expect(screen.getByRole('link', { name: 'Draft from video' }).getAttribute('href')).toBe('/jobs/new');
    expect(backend.query).toHaveBeenCalledTimes(1);
    expect(backend.query).toHaveBeenCalledWith(role === 'author' ? 'draftJobs:listMine' : 'draftJobs:list', {});
  });

  it('shows an empty state', () => {
    backend.query.mockReturnValue([]);
    render(app('/jobs'));
    expect(screen.getByText('No jobs yet.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a loading notice before results arrive', () => {
    backend.query.mockReturnValue(undefined);
    render(app('/jobs'));
    expect(screen.getByRole('status').textContent).toBe('Loading jobs…');
    expect(screen.queryByText('No jobs yet.')).toBeNull();
  });

  it.each(['/jobs', '/jobs/job-id'])('skips protected queries for trainees at %s', (path) => {
    backend.role = 'trainee';
    render(app(path));
    expect(screen.getByRole('alert').textContent).toBe('Not authorized');
    expect(backend.query).not.toHaveBeenCalled();
  });
});
