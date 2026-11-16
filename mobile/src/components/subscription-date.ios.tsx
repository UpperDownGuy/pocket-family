import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle, disabled as disabledModifier, environment } from '@expo/ui/swift-ui/modifiers';
import { usePalette } from './pocket-ui';

interface SubscriptionDateProps { value: string; label: string; disabled: boolean; onChange(value: string): void }

export function SubscriptionDate({ value, label, disabled, onChange }: SubscriptionDateProps) {
  const colors = usePalette();
  // This is a calendar date, not an instant. Fix the picker to UTC so selecting
  // a day preserves that day when the billing and phone time zones differ.
  const selection = new Date(`${value}T12:00:00.000Z`);
  return <Host matchContents={{ vertical: true }} style={{ width: '100%' }} seedColor={colors.accent} ignoreSafeArea="all">
    <DatePicker title={label} selection={Number.isNaN(selection.getTime()) ? new Date() : selection} displayedComponents={['date']}
      onDateChange={date => { if (!disabled) onChange(date.toISOString().slice(0, 10)); }}
      modifiers={[datePickerStyle('compact'), environment('timeZone', 'UTC'), disabledModifier(disabled)]} />
  </Host>;
}
