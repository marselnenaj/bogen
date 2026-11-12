import Badge from '@/components/Badge';

export default {
  component: Badge,
  args: { label: 'New' },
};

const Template = (args) => <Badge {...args} />;

export const Plain = Template.bind({});
Plain.args = { count: 3 };

export const Solid = Template.bind({});
Solid.args = { solid: true, label: 'Hot' };
Solid.storyName = 'Solid badge';
