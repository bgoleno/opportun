import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BuildVersionText, buildLabel } from './-buildVersion';

// https://github.com/bgoleno/opportun/issues/480: the running version and commit, from the build.
describe('buildLabel', () => {
  it('a published version and its commit', () => {
    expect(buildLabel({ version: '0.3.1', commit: 'd4d97b6' })).toBe('Version 0.3.1 (d4d97b6)');
  });

  it('only a commit: a development build at that commit', () => {
    expect(buildLabel({ version: null, commit: 'd4d97b6' })).toBe('Development build (d4d97b6)');
  });

  it('neither: says so plainly, never a made-up number', () => {
    expect(buildLabel({ version: null, commit: null })).toBe('Development build');
  });

  it('a version with no commit still says the version', () => {
    expect(buildLabel({ version: '0.3.1', commit: null })).toBe('Version 0.3.1');
  });
});

describe('BuildVersionText', () => {
  it('shows the label, and nothing until the server has answered', () => {
    const { rerender, container } = render(<BuildVersionText info={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BuildVersionText info={{ version: '0.3.1', commit: 'd4d97b6' }} />);
    expect(screen.getByText('Version 0.3.1 (d4d97b6)')).toBeInTheDocument();
  });
});
