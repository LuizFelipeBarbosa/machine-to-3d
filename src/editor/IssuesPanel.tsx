import type { JSX } from 'react';
import type { Step } from '../../shared/procedure';
import type { ProcedureIssue } from '../../shared/validateProcedure';

type IssuesPanelProps = {
  issues: ProcedureIssue[];
  steps: Step[];
  onSelect(id: string): void;
};

export function IssuesPanel({ issues, steps, onSelect }: IssuesPanelProps): JSX.Element {
  return (
    <section className="editor-issues" aria-label="Validation issues">
      <h3>Validation issues</h3>
      {issues.length === 0 ? <p className="editor-hint">No issues</p> : (
        <ul className="editor-issue-list">
          {issues.map((issue, index) => {
            const match = /^steps\[(\d+)\]/.exec(issue.path);
            const step = match ? steps[Number(match[1])] : undefined;
            const description = <><span className="editor-issue-path">{issue.path}</span>{issue.message}</>;
            return (
              <li key={`${issue.path}-${index}`}>
                {step ? (
                  <button type="button" className="issue" onClick={() => onSelect(step.id)}>{description}</button>
                ) : <div className="issue">{description}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
