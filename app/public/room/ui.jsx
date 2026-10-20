import clsx from 'clsx';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';

// Class names are whole literals so Tailwind's content scan finds them; the styles are
// in styles/room.css.
const BUTTON_VARIANT = { primary: 'btn-primary', secondary: 'btn-secondary', ghost: 'btn-ghost' };
const BUTTON_SIZE = { md: undefined, lg: 'btn-lg', xl: 'btn-xl' };
const ICON_BUTTON_SIZE = { md: undefined, sm: 'icon-btn-sm', bar: undefined };
// `bar` is the player bar's: a larger icon in the same hit area as `md`.
const ICON_PIXELS = { md: 20, sm: 16, bar: 30 };
const FIELD_SIZE = { md: undefined, lg: 'field-lg', xl: 'field-xl' };

export function VisuallyHidden({ as: Tag = 'span', className, ...rest }) {
  return <Tag className={clsx('sr-only', className)} {...rest} />;
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }) {
  return <button type={type} className={clsx('btn', BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)} {...rest} />;
}

// A kept engine button passes `labelRef` and no `label`: the engine writes its text into
// that span, and the button's textContent must stay that text alone. A `title` on the icon
// or any other text node breaks it. `iconClassName` wraps the icon so a stylesheet can draw
// over it with generated content, which adds no text node either. `fill` is spread only when
// asked for, so every other icon keeps lucide's outline default.
export function IconButton({ id, label, labelRef, icon: Icon, size = 'md', filled = false, iconClassName, className, ...rest }) {
  const icon = <Icon size={ICON_PIXELS[size]} strokeWidth={2} aria-hidden="true" {...(filled ? { fill: 'currentColor' } : {})} />;
  return <button id={id} type="button" className={clsx('icon-btn', ICON_BUTTON_SIZE[size], className)} {...rest}>
    {iconClassName ? <span className={iconClassName}>{icon}</span> : icon}
    <VisuallyHidden ref={labelRef}>{label}</VisuallyHidden>
  </button>;
}

export function Card({ className, ...rest }) {
  return <div className={clsx('card', className)} {...rest} />;
}

// The popup is portalled to body, so it floats over the page and pushes nothing, and its content
// exists only while open.
export function PopoverPanel({ className, children, ...positioning }) {
  return <Popover.Portal>
    <Popover.Positioner className="popover-positioner" sideOffset={8} {...positioning}>
      <Popover.Popup className={clsx('popover', className)}>{children}</Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>;
}

// The popover's surface, centred over a backdrop. Modal, so a click outside it is an outside
// press that closes it, and nothing behind it takes the click.
export function DialogPanel({ className, children, ...popup }) {
  return <Dialog.Portal>
    <Dialog.Backdrop className="dialog-backdrop" />
    <Dialog.Popup className={clsx('popover dialog-popup', className)} {...popup}>{children}</Dialog.Popup>
  </Dialog.Portal>;
}

// Controlled, so the caller's value stays the truth: pressing the pressed item reports an
// empty group and is dropped here. An option's other props (a `data-*` a driver reads) ride
// on its item, which Base UI renders with `aria-pressed`.
export function SegmentedControl({ options, value, onChange, className, ...rest }) {
  const change = (next) => {
    if (next.length === 1 && next[0] !== value) onChange(next[0]);
  };
  return <ToggleGroup value={[value]} onValueChange={change} className={clsx('segmented', className)} {...rest}>
    {options.map(({ value: itemValue, label, ...attrs }) => (
      <Toggle key={itemValue} value={itemValue} className="segment" {...attrs}>{label}</Toggle>
    ))}
  </ToggleGroup>;
}

export function TextField({ id, label, size = 'md', className, ...rest }) {
  return <>
    <VisuallyHidden as="label" htmlFor={id}>{label}</VisuallyHidden>
    <input id={id} type="text" className={clsx('field', FIELD_SIZE[size], className)} {...rest} />
  </>;
}
