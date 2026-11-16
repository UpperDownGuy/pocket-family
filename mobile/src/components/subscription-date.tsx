import { Field } from './pocket-ui';

export interface SubscriptionDateProps { value: string; label: string; disabled: boolean; onChange(value: string): void }

export function SubscriptionDate({ value, label, disabled, onChange }: SubscriptionDateProps) {
  return <Field label={`${label} · YYYY-MM-DD`} value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} editable={!disabled} />;
}
