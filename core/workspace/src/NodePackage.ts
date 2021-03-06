export class NodePackage {
  name: string;
  version: string;
  private: boolean;
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
  peerDependencies: Map<string, string>;

  get allDependencies() {
    return new Map([
      ...this.dependencies.entries(),
      ...this.devDependencies.entries(),
      ...this.peerDependencies.entries()
    ]);
  }

  constructor(
    public readonly packageJson: {
      name: string;
      version: string;
      private: boolean;
      dependencies: { [name: string]: string };
      devDependencies: { [name: string]: string };
      peerDependencies: { [name: string]: string };
    }
  ) {
    this.name = packageJson.name;
    this.version = packageJson.version;
    this.private = Boolean(packageJson.private);
    this.dependencies = new Map(Object.entries(packageJson.dependencies || {}));
    this.devDependencies = new Map(
      Object.entries(packageJson.devDependencies || {})
    );
    this.peerDependencies = new Map(
      Object.entries(packageJson.peerDependencies || {})
    );
  }
}
