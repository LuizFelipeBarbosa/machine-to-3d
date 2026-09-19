import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProcedureContent } from '../../shared/procedure';
import { errorMessage } from '../lib/errorMessage';
import { useEditorStore } from './editorStore';

export type AutosaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';
export type AutosaveControls = {
  status: AutosaveStatus;
  error: string | null;
  saveNow(): Promise<boolean>;
  flush(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): void;
};

export function useAutosave(onSave?: (content: ProcedureContent) => Promise<void>): AutosaveControls {
  const content = useEditorStore((store) => store.content);
  const dirty = useEditorStore((store) => store.dirty);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ content: ProcedureContent; message: string } | null>(null);
  const [resumeCount, setResumeCount] = useState(0);
  const save = useRef(onSave);
  const snapshot = useRef(useEditorStore.getState());
  const active = useRef(false);
  const paused = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);

  useLayoutEffect(() => { save.current = onSave; }, [onSave]);

  const saveNow = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const { content, dirty } = snapshot.current;
    const onSave = save.current;
    if (!dirty || !content) return Promise.resolve(true);
    if (!onSave) return Promise.resolve(false);
    if (active.current) {
      setSaving(true);
      setFailure(null);
    }
    const request = Promise.resolve().then(async () => {
      try {
        await onSave(content);
        // An acknowledgement only clears the exact snapshot sent to the server.
        if (snapshot.current.content === content) {
          snapshot.current = { ...snapshot.current, dirty: false };
          if (active.current && useEditorStore.getState().content === content) {
            useEditorStore.getState().markSaved();
          }
        }
        return true;
      } catch (cause) {
        if (active.current) setFailure({ content, message: errorMessage(cause) });
        return false;
      } finally {
        inFlight.current = null;
        if (active.current) setSaving(false);
      }
    });
    inFlight.current = request;
    return request;
  }, []);

  const flush = useCallback(async () => {
    // Preview and approval also wait for any edits made during an earlier save.
    if (inFlight.current && !await inFlight.current) return false;
    while (snapshot.current.dirty) {
      if (!await saveNow()) return false;
    }
    return true;
  }, [saveNow]);

  const pause = useCallback(async () => {
    paused.current = true;
    await inFlight.current;
  }, []);

  const resume = useCallback(() => {
    paused.current = false;
    setResumeCount((count) => count + 1);
  }, []);

  useLayoutEffect(() => {
    active.current = true;
    snapshot.current = useEditorStore.getState();
    const unsubscribe = useEditorStore.subscribe((state) => { snapshot.current = state; });
    function saveBeforeLeaving() {
      if (!paused.current) void flush();
    }
    window.addEventListener('beforeunload', saveBeforeLeaving);
    return () => {
      // Keep this editor's last snapshot when the next route loads another draft.
      unsubscribe();
      active.current = false;
      window.removeEventListener('beforeunload', saveBeforeLeaving);
      saveBeforeLeaving();
    };
  }, [flush]);

  const error = failure?.content === content ? failure.message : null;
  useEffect(() => {
    if (!dirty || !onSave || saving || error || paused.current) return;
    const timer = window.setTimeout(() => {
      if (!paused.current) void saveNow();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [content, dirty, onSave, saving, error, resumeCount, saveNow]);

  const status: AutosaveStatus = saving ? 'saving' : error ? 'error' : dirty ? 'unsaved' : 'saved';
  return { status, error, saveNow, flush, pause, resume };
}
