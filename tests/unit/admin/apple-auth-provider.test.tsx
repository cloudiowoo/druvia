// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AppleProviderConfigForm,
  type AppleProviderConfigValue,
} from '../../../apps/admin/src/components/auth/AppleProviderConfigForm';

const value: AppleProviderConfigValue = {
  clientId: 'com.example.pitchetch',
  clientSecret: '',
  teamId: 'TEAMID1234',
  keyId: 'KEYID12345',
  allowedAudiences: 'com.example.pitchetch',
};

describe('AppleProviderConfigForm', () => {
  it('shows only the project-facing Apple identifiers and a write-only private key input', () => {
    render(<AppleProviderConfigForm value={value} configured onChange={vi.fn()} />);

    expect(screen.getByLabelText('Bundle ID')).toHaveValue('com.example.pitchetch');
    expect(screen.getByLabelText('Team ID')).toHaveValue('TEAMID1234');
    expect(screen.getByLabelText('Key ID')).toHaveValue('KEYID12345');
    expect(screen.getByLabelText('允许的 Audience')).toHaveValue('com.example.pitchetch');
    expect(screen.getByLabelText('私钥 (.p8)')).toHaveValue('');
    expect(screen.queryByText(/appleid\.apple\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hasura/i)).not.toBeInTheDocument();
  });

  it('returns private-key edits without exposing an existing secret', () => {
    const onChange = vi.fn();
    render(<AppleProviderConfigForm value={value} configured onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('私钥 (.p8)'), {
      target: { value: '-----BEGIN PRIVATE KEY-----' },
    });

    expect(onChange).toHaveBeenCalledWith({
      ...value,
      clientSecret: '-----BEGIN PRIVATE KEY-----',
    });
  });
});
