// Test runners set NODE_ENV=test; the shipped UI must always use production React.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build();
