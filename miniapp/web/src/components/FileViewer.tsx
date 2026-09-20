import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { Markdown } from './MarkdownAsync';
import { Download, Spinner } from './Icons';
import { api } from '../api';
import { downloadBlob } from '../telegram';
import { formatBytes } from '../utils/format';
import type { ArtifactFile, ArtifactGroup } from '../types';

/** PDFs are classified `binary` by the server's kind map, so check by extension. */
const isPdf = (file: ArtifactFile) => file.path.toLowerCase().endsWith('.pdf');

type Loaded =
  | { state: 'loading' }
  | { state: 'text'; body: string }
  | { state: 'image'; url: string }
  | { state: 'binary' }
  | { state: 'pdf'; body: string }
  | { state: 'failed'; reason: string };

/**
 * One artifact, opened in place.
 *
 * Markdown renders through the same pipeline as an answer, with a raw
 * toggle for when the source is what you actually want. Images get the full
 * width. Anything we cannot show meaningfully is offered as a download
 * rather than dumped as mojibake.
 *
 * Bytes are fetched rather than pointed at with a `src`: the artifact route
 * is bearer-authenticated, and an `<img>` tag cannot carry the header.
 */
export function FileViewer({
  sessionId,
  group,
  file,
  onClose,
}: {
  sessionId: string;
  group: ArtifactGroup;
  file: ArtifactFile;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl = '';

    if (isPdf(file)) {
      api.pdfText(sessionId, group, file.path).then(
        (res) => alive && setLoaded({ state: 'pdf', body: res.text }),
        (err: Error) =>
          alive && setLoaded({ state: 'failed', reason: err.message }),
      );
      return undefined;
    }

    if (file.kind === 'binary') {
      setLoaded({ state: 'binary' });
      return undefined;
    }

    api.artifactBlob(sessionId, group, file.path).then(
      async (blob) => {
        if (!alive) return;
        if (file.kind === 'image') {
          objectUrl = URL.createObjectURL(blob);
          setLoaded({ state: 'image', url: objectUrl });
        } else {
          setLoaded({ state: 'text', body: await blob.text() });
        }
      },
      (err: Error) => alive && setLoaded({ state: 'failed', reason: err.message }),
    );

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, group, file]);

  const markdown = file.kind === 'markdown';

  return (
    <Sheet
      side="bottom"
      title={file.name}
      subtitle={`${file.path} · ${formatBytes(file.size)}`}
      onClose={onClose}
    >
      {markdown && loaded.state === 'text' ? (
        <button
          type="button"
          className="show-more file-raw-toggle surface-row"
          data-surface-row="format-toggle"
          onClick={() => setRaw((prev) => !prev)}
        >
          {raw ? 'Rendered' : 'Raw'}
        </button>
      ) : null}

      {loaded.state === 'loading' ? (
        <p className="panel-empty surface-meta" data-surface-meta="loading">
          <Spinner size={13} /> Loading…
        </p>
      ) : null}
      {loaded.state === 'failed' ? (
        <p className="panel-empty surface-meta" data-surface-meta="error">
          Could not open this file ({loaded.reason}).
        </p>
      ) : null}
      {loaded.state === 'image' ? (
        <img
          className="file-image surface-content"
          data-surface-content="image"
          src={loaded.url}
          alt={file.name}
          decoding="async"
        />
      ) : null}
      {loaded.state === 'text' ? (
        markdown && !raw ? (
          <Markdown text={loaded.body} sessionId={sessionId} />
        ) : (
          <pre
            className="file-source surface-content"
            data-surface-content="source"
          >
            {loaded.body}
          </pre>
        )
      ) : null}
      {loaded.state === 'pdf' ? (
        <>
          <pre
            className="file-pdf surface-content"
            data-surface-content="pdf"
          >
            {loaded.body}
          </pre>
          <button
            type="button"
            className="panel-row surface-row"
            data-surface-row="download"
            onClick={() => {
              void api
                .artifactBlob(sessionId, group, file.path)
                .then((blob) => downloadBlob(blob, file.name));
            }}
          >
            <Download size={15} strokeWidth={1.75} />
            <span className="panel-row-name">Download original {file.name}</span>
          </button>
        </>
      ) : null}
      {loaded.state === 'binary' ? (
        <button
          type="button"
          className="panel-row surface-row"
          data-surface-row="download"
          onClick={() => {
            void api
              .artifactBlob(sessionId, group, file.path)
              .then((blob) => downloadBlob(blob, file.name));
          }}
        >
          <Download size={15} strokeWidth={1.75} />
          <span className="panel-row-name">Download {file.name}</span>
        </button>
      ) : null}
    </Sheet>
  );
}
