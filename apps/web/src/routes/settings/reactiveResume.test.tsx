import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactiveResumeStatus } from '@/components/resume/api';
import { ReactiveResumeSettings } from './-reactiveResume';

const DISCONNECTED: ReactiveResumeStatus = {
  baseUrl: null,
  keySet: false,
  connected: false,
  targetVersions: ['6.0'],
};
const CONNECTED: ReactiveResumeStatus = {
  baseUrl: 'https://rr.example.com',
  keySet: true,
  connected: true,
  targetVersions: ['6.0'],
};

function setup(status: ReactiveResumeStatus, store: 'google' | 'reactive_resume' = 'google') {
  const props = {
    status,
    store,
    saving: false,
    validating: false,
    storeSaving: false,
    validation: null,
    error: null,
    onSave: vi.fn(),
    onValidate: vi.fn(),
    onDisconnect: vi.fn(),
    onStoreChange: vi.fn(),
  };
  render(<ReactiveResumeSettings {...props} />);
  return props;
}

describe('ReactiveResumeSettings', () => {
  it('names the targeted versions and says honestly what is lost compared with Google Docs', () => {
    setup(DISCONNECTED);
    expect(screen.getByTestId('rr-versions')).toHaveTextContent('6.0');
    expect(screen.getByTestId('rr-lossy')).toHaveTextContent(/formatting/);
  });

  it('needs both an address and a key for a first save, and sends them', async () => {
    const user = userEvent.setup();
    const props = setup(DISCONNECTED);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Reactive Resume address'), 'https://rr.example.com');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('API key'), 'rr-key-0123456789');
    await user.click(save);
    expect(props.onSave).toHaveBeenCalledWith({
      baseUrl: 'https://rr.example.com',
      apiKey: 'rr-key-0123456789',
    });
    // The key field is a password field and is cleared after saving.
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });

  it('requires the key again when the address changes', async () => {
    const user = userEvent.setup();
    setup(CONNECTED);
    const address = screen.getByLabelText('Reactive Resume address');
    expect(address).toHaveValue('https://rr.example.com');
    await user.clear(address);
    await user.type(address, 'https://other.example.org');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/enter the API key again/i)).toBeInTheDocument();
  });

  it('validates and disconnects only once connected', () => {
    setup(DISCONNECTED);
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('picks the store for new resumes: Google by default, Reactive Resume only when connected', () => {
    setup(DISCONNECTED);
    expect(screen.getByLabelText('Google Docs')).toBeChecked();
    expect(screen.getByLabelText('Reactive Resume')).toBeDisabled();
  });

  it('switches the store and validates when connected', async () => {
    const user = userEvent.setup();
    const props = setup(CONNECTED);
    await user.click(screen.getByLabelText('Reactive Resume'));
    expect(props.onStoreChange).toHaveBeenCalledWith('reactive_resume');
    expect(screen.getByText(/existing resumes stay/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    expect(props.onValidate).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(props.onDisconnect).toHaveBeenCalled();
  });

  it('shows the validation result', () => {
    render(
      <ReactiveResumeSettings
        status={CONNECTED}
        store="reactive_resume"
        saving={false}
        validating={false}
        storeSaving={false}
        validation={{ ok: false, version: '6.0.3', error: 'unauthorized' }}
        error={null}
        onSave={vi.fn()}
        onValidate={vi.fn()}
        onDisconnect={vi.fn()}
        onStoreChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/rejected the API key/);
  });
});
