import { useId, useRef } from 'react';
import type { JSX } from 'react';

type ReferenceVideoProps = {
  url: string;
  label?: string;
};

export function ReferenceVideo({ url, label }: ReferenceVideoProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const id = useId();

  return (
    <>
      <button
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-controls={id}
        title={label}
        onClick={() => dialog.current?.showModal()}
      >
        Reference video
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="video-dialog"
        aria-labelledby={`${id}-title`}
        onClose={() => video.current?.pause()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="video-dialog-head">
          <h2 id={`${id}-title`}>{label ?? 'Reference video'}</h2>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <video ref={video} controls playsInline preload="metadata" src={url} />
      </dialog>
    </>
  );
}
