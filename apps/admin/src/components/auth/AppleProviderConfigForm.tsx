'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface AppleProviderConfigValue {
  clientId: string;
  clientSecret: string;
  teamId: string;
  keyId: string;
  allowedAudiences: string;
}

export function AppleProviderConfigForm({
  value,
  configured,
  onChange,
}: {
  value: AppleProviderConfigValue;
  configured: boolean;
  onChange: (value: AppleProviderConfigValue) => void;
}) {
  const update = (field: keyof AppleProviderConfigValue, fieldValue: string) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="apple-client-id">Bundle ID</Label>
        <Input
          id="apple-client-id"
          value={value.clientId}
          onChange={(event) => update('clientId', event.target.value)}
          placeholder="com.example.app"
          autoComplete="off"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="apple-team-id">Team ID</Label>
          <Input
            id="apple-team-id"
            value={value.teamId}
            onChange={(event) => update('teamId', event.target.value)}
            maxLength={10}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="apple-key-id">Key ID</Label>
          <Input
            id="apple-key-id"
            value={value.keyId}
            onChange={(event) => update('keyId', event.target.value)}
            maxLength={10}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="apple-audiences">允许的 Audience</Label>
        <Input
          id="apple-audiences"
          value={value.allowedAudiences}
          onChange={(event) => update('allowedAudiences', event.target.value)}
          placeholder="com.example.app"
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="apple-private-key">私钥 (.p8)</Label>
        <Textarea
          id="apple-private-key"
          value={value.clientSecret}
          onChange={(event) => update('clientSecret', event.target.value)}
          placeholder={configured ? '留空保持不变' : '-----BEGIN PRIVATE KEY-----'}
          rows={6}
          maxLength={16 * 1024}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
