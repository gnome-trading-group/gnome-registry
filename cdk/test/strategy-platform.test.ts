import { parsePlatformProperties, parsePomPlatform } from '../lambda/endpoints/strategy-platform';

describe('platform pins', () => {
  it("reads strategies/pom.xml's platform properties", () => {
    const pom = `<project>
  <properties>
    <platform.orchestrator> 1.40.0 </platform.orchestrator>
    <maven.deploy.skip>true</maven.deploy.skip>
  </properties>
</project>`;
    expect(parsePomPlatform(pom)).toEqual({ orchestrator: '1.40.0' });
    expect(parsePomPlatform('<project/>')).toEqual({ orchestrator: undefined });
  });

  it("reads gnomepy-research's platform.properties, skipping comments", () => {
    const text = '# The platform this commit runs on.\r\norchestrator = 1.40.0\n\n#gnomepy=0.0.1\ngnomepy=3.15.2\n';
    expect(parsePlatformProperties(text)).toEqual({ orchestrator: '1.40.0', gnomepy: '3.15.2' });
  });
});
