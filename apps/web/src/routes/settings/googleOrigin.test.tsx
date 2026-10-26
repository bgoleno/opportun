import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OriginWarning, requiredOrigin } from './-googleOrigin';

// jsdom serves tests from http://localhost:3000 (see vitest config); the guard compares
// against that as the browsing origin.
const HERE = window.location.origin;

describe('requiredOrigin', () => {
  it('is null while status is loading', () => {
    expect(requiredOrigin(undefined)).toBeNull();
  });

  it('is null when the browser is already on the base origin', () => {
    expect(requiredOrigin(`${HERE}/api/v1/integrations/google/callback`)).toBeNull();
  });

  it('names the base origin when browsing anywhere else, so connect is blocked', () => {
    expect(
      requiredOrigin('https://opportun.example.ts.net/api/v1/integrations/google/callback'),
    ).toBe('https://opportun.example.ts.net');
  });
});

describe('OriginWarning', () => {
  // ADR-14: on a LAN install the required origin is http://localhost:8080, which on the
  // phone reading this means the phone. Lead with what to do, not with an address to open.
  it('tells the reader to connect from the machine running Opportun, not to open localhost', () => {
    render(<OriginWarning origin="http://localhost:8080" action="connect" />);
    const told = screen.getByText(/machine running Opportun/i);
    expect(told.textContent).toMatch(/^Google is connected once, from a browser on the machine/);
    expect(told.textContent).toMatch(/not from this device/i);
    expect(told.textContent).not.toMatch(/^You are browsing at/);
  });

  it('links to the integrations page on the required origin', () => {
    render(<OriginWarning origin="https://opportun.example.ts.net" action="connect" />);
    const warning = screen.getByTestId('google-origin-warning');
    expect(warning).toHaveTextContent('does not carry across addresses');
    expect(screen.getByRole('link', { name: 'https://opportun.example.ts.net' })).toHaveAttribute(
      'href',
      'https://opportun.example.ts.net/settings/integrations',
    );
  });
});
