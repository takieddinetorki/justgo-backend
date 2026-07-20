/**
 * Data-driven form definition (§9): verticals declare their onboarding and
 * profile fields as data; the apps render them without code changes.
 */
export type FormFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'phone'
  | 'email'
  | 'photo'
  | 'geo'
  | 'hours';

export interface FormField {
  key: string;
  type: FormFieldType;
  /** i18n label keys, e.g. { en: 'Truck plate', es: '…', fr: '…' } */
  labelI18n: Record<string, string>;
  required: boolean;
  options?: { value: string; labelI18n: Record<string, string> }[];
}

export interface FormSchema {
  fields: FormField[];
}
