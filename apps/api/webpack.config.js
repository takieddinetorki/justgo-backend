const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');
const webpack = require('webpack');

module.exports = {
  resolve: {
    // resolve workspace libs to their TypeScript source (TS solution setup)
    conditionNames: ['@justgo-backend/source', 'node', 'require', 'default'],
  },
  output: {
    path: join(__dirname, 'dist'),
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    // @nestjs/swagger -> @nestjs/mapped-types dynamically require()s the
    // optional class-validator / class-transformer (guarded at runtime and
    // unused here — we validate with zod). Ignore so the node bundle builds
    // clean instead of erroring on the unresolved optional peers.
    new webpack.IgnorePlugin({
      resourceRegExp: /^class-(validator|transformer)(\/.*)?$/,
    }),
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'swc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMaps: true,
    }),
  ],
};
