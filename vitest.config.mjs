export default {
  test: {
    include: ["tests/**/*.test.mjs", "tests/remote-connectivity.test.mjs"],
    reporters: "dot",
    watch: false,
    hookTimeout: 20000,
    testTimeout: 30000,
    environment: "node",
  },
};
