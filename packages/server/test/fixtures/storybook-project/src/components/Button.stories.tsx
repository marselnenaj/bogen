import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Button } from './Button';

const meta = {
  title: 'Actions/Button',
  component: Button,
  args: { children: 'Save', onClick: fn() },
  argTypes: {
    tone: { control: 'select', options: ['primary', 'secondary', 'danger'] },
    size: { control: { type: 'radio' }, options: ['sm', 'md'] },
    disabled: { control: 'boolean' },
    onClick: { table: { disable: true } },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { tone: 'primary' },
};

export const Secondary: Story = {
  args: { tone: 'secondary', children: 'Cancel' },
};

export const DangerSmall: Story = {
  name: 'Danger, small',
  args: {
    tone: 'danger',
    size: 'sm',
    // A comment, and a value from elsewhere that stays the component's own.
    icon: <span>!</span>,
    children: `Delete`,
  },
};
