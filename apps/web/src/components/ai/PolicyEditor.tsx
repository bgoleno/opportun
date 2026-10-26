// Per-task model policy: provider, model, output cap, temperature and optional prices, with
// reset to the built-in default. Defaults come from the server (config data), never from this file.
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { applyServerError, numberText } from '@/lib/forms';
import {
  providerLabel,
  PROVIDERS,
  usePolicies,
  useResetPolicy,
  useSavePolicy,
  type ModelPolicy,
  type TaskPolicy,
} from './api';

/** Mirrors the server's MAX_PRICE_OVERRIDE_USD_PER_MTOK. */
const MAX_PRICE = 10_000;

const PriceText = z
  .string()
  .trim()
  .refine(
    (s) => s === '' || (Number.isFinite(Number(s)) && Number(s) >= 0 && Number(s) <= MAX_PRICE),
    { message: `Leave blank, or enter 0 to ${MAX_PRICE}` },
  );

function isAllowedBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const PolicyFormSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1, 'Enter a model id').max(200),
    maxOutputTokens: z
      .string()
      .trim()
      .refine((s) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 200_000, {
        message: 'Enter a whole number from 1 to 200000',
      }),
    temperature: z
      .string()
      .trim()
      .refine((s) => s === '' || (Number.isFinite(Number(s)) && Number(s) >= 0 && Number(s) <= 2), {
        message: 'Leave blank, or enter 0 to 2',
      }),
    baseUrl: z.string().trim().max(2048),
    inputUsdPerMTok: PriceText,
    outputUsdPerMTok: PriceText,
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'openai_compatible' && !isAllowedBaseUrl(v.baseUrl)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Use an https URL, or http://localhost for a local runtime',
      });
    }
  });
type PolicyForm = z.infer<typeof PolicyFormSchema>;

function toForm(p: ModelPolicy): PolicyForm {
  return {
    provider: p.provider,
    model: p.model,
    maxOutputTokens: String(p.maxOutputTokens),
    temperature: numberText(p.temperature),
    baseUrl: p.baseUrl ?? '',
    inputUsdPerMTok: numberText(p.inputUsdPerMTok),
    outputUsdPerMTok: numberText(p.outputUsdPerMTok),
  };
}

function toPolicy(f: PolicyForm): ModelPolicy {
  return {
    provider: f.provider,
    model: f.model,
    maxOutputTokens: Number(f.maxOutputTokens),
    ...(f.temperature === '' ? {} : { temperature: Number(f.temperature) }),
    ...(f.provider === 'openai_compatible' ? { baseUrl: f.baseUrl } : {}),
    ...(f.inputUsdPerMTok === '' ? {} : { inputUsdPerMTok: Number(f.inputUsdPerMTok) }),
    ...(f.outputUsdPerMTok === '' ? {} : { outputUsdPerMTok: Number(f.outputUsdPerMTok) }),
  };
}

function PolicyForm({ task, onDone }: { task: TaskPolicy; onDone: () => void }) {
  const save = useSavePolicy();
  const reset = useResetPolicy();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<PolicyForm>({
    resolver: zodResolver(PolicyFormSchema),
    defaultValues: toForm(task.override ?? task.defaultPolicy),
  });
  const { errors, isSubmitting } = form.formState;
  const provider = form.watch('provider');

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await save.mutateAsync({ taskKey: task.taskKey, policy: toPolicy(values) });
      onDone();
    } catch (err) {
      setFormError(
        applyServerError(err, form.setError, [
          'provider',
          'model',
          'maxOutputTokens',
          'temperature',
          'baseUrl',
          'inputUsdPerMTok',
          'outputUsdPerMTok',
        ]),
      );
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 py-2 sm:grid-cols-2">
      <FormError message={formError} className="sm:col-span-2" />
      <FormField label="Provider" error={errors.provider?.message}>
        {(p) => (
          <Select {...p} {...form.register('provider')}>
            {PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {providerLabel(id)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Model" error={errors.model?.message}>
        {(p) => <Input {...p} spellCheck={false} {...form.register('model')} />}
      </FormField>
      <FormField label="Max output tokens" error={errors.maxOutputTokens?.message}>
        {(p) => <Input {...p} inputMode="numeric" {...form.register('maxOutputTokens')} />}
      </FormField>
      <FormField
        label="Temperature"
        error={errors.temperature?.message}
        hint="Blank uses the provider default. Some models reject this setting."
      >
        {(p) => <Input {...p} inputMode="decimal" {...form.register('temperature')} />}
      </FormField>
      {provider === 'openai_compatible' ? (
        <FormField
          label="Base URL"
          error={errors.baseUrl?.message}
          hint="https, or http://localhost for a local runtime. Your openai_compatible key is sent here."
          className="sm:col-span-2"
        >
          {(p) => (
            <Input
              {...p}
              type="url"
              spellCheck={false}
              placeholder="http://localhost:11434/v1"
              {...form.register('baseUrl')}
            />
          )}
        </FormField>
      ) : null}
      <FormField
        label="Input price (USD per million tokens)"
        error={errors.inputUsdPerMTok?.message}
        hint="Optional. Blank uses the built-in price list."
      >
        {(p) => <Input {...p} inputMode="decimal" {...form.register('inputUsdPerMTok')} />}
      </FormField>
      <FormField
        label="Output price (USD per million tokens)"
        error={errors.outputUsdPerMTok?.message}
        hint="Optional. Set both for a model without a list price, such as a local runtime."
      >
        {(p) => <Input {...p} inputMode="decimal" {...form.register('outputUsdPerMTok')} />}
      </FormField>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {task.override !== null ? (
          <Button
            type="button"
            variant="outline"
            className="sm:ml-auto"
            onClick={() => {
              reset.mutate(task.taskKey);
              onDone();
            }}
          >
            Reset to default
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function PolicyEditor() {
  const policies = usePolicies();
  const [editing, setEditing] = useState<string | null>(null);

  if (policies.isPending)
    return <p className="text-sm text-muted-foreground">Loading policies...</p>;
  if (policies.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load model policies.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Daily budget: ${policies.data.budget.perTaskDailyUsd.toFixed(2)} per task, measured by
        estimated cost. Calls for a task stop once it is reached, until the next UTC day. Models
        without a list price (including local or gateway models) are counted at the highest listed
        price unless you set the policy&apos;s own prices.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Max output</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {policies.data.items.map((task) => {
            const effective = task.override ?? task.defaultPolicy;
            return [
              <TableRow key={task.taskKey}>
                <TableCell>
                  <div className="font-mono text-xs">{task.taskKey}</div>
                  <div className="text-xs text-muted-foreground">{task.description}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{effective.model}</span>
                    <Badge variant={task.override === null ? 'secondary' : 'default'}>
                      {task.override === null ? 'Default' : 'Custom'}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {providerLabel(effective.provider)}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {effective.maxOutputTokens.toLocaleString()}
                </TableCell>
                <TableCell>
                  <IconButton
                    variant="ghost"
                    label={`Edit model for ${task.taskKey}`}
                    aria-expanded={editing === task.taskKey}
                    onClick={() => setEditing(editing === task.taskKey ? null : task.taskKey)}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                </TableCell>
              </TableRow>,
              editing === task.taskKey ? (
                <TableRow key={`${task.taskKey}-edit`}>
                  <TableCell colSpan={4}>
                    <PolicyForm task={task} onDone={() => setEditing(null)} />
                  </TableCell>
                </TableRow>
              ) : null,
            ];
          })}
        </TableBody>
      </Table>
    </div>
  );
}
