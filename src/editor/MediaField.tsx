import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { Step } from '../../shared/procedure';
import { isConvexMode } from '../data/mode';
import { errorMessage } from '../lib/errorMessage';

type MediaFieldProps = {
  media: Step['media'];
  mediaUrls?: Record<string, string>;
  onChange(media: Step['media']): void;
  onUploadStateChange?(uploading: boolean): void;
};

function UploadField({ media, mediaUrls, onChange, onUploadStateChange }: MediaFieldProps) {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedId, setUploadedId] = useState<Id<'_storage'> | null>(null);
  const uploadedUrl = useQuery(api.files.mediaUrl, uploadedId ? { fileId: uploadedId } : 'skip');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    onUploadStateChange?.(uploading);
    return () => onUploadStateChange?.(false);
  }, [onUploadStateChange, uploading]);

  async function upload(file: File) {
    if (uploading) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }
    setUploading(true);
    try {
      const url = await generateUploadUrl({ kind: 'media' });
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': file.type }, body: file,
      });
      if (!response.ok) throw new Error('The image could not be uploaded. Please try again.');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('storageId' in result) || typeof result.storageId !== 'string') {
        throw new Error('The upload did not return a file id.');
      }
      if (!mounted.current) return;
      const storageId = result.storageId as Id<'_storage'>;
      setUploadedId(storageId);
      onChange({ fileId: storageId, alt: media?.alt ?? '' });
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setUploading(false);
    }
  }

  const thumbnail = media && (mediaUrls?.[media.fileId]
    ?? (media.fileId === uploadedId ? uploadedUrl : undefined));
  return (
    <fieldset className="editor-fieldset" disabled={uploading}>
      <legend>Screenshot or image</legend>
      <label className="editor-field">
        Image
        <input type="file" accept="image/*" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }} />
      </label>
      {uploading && <p role="status">Uploading image…</p>}
      {media && (
        <>
          {thumbnail && <img className="step-media" src={thumbnail} alt={media.alt} />}
          <label className="editor-field">
            Alt text
            <input value={media.alt} onChange={(event) => onChange({ ...media, alt: event.target.value })} />
          </label>
          <button type="button" className="btn" onClick={() => onChange(undefined)}>Remove</button>
        </>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
    </fieldset>
  );
}

export function MediaField(props: MediaFieldProps) {
  if (!isConvexMode) return <p className="editor-hint">Uploads need the backend</p>;
  return <UploadField {...props} />;
}
