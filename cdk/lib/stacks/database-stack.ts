import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { DatabaseInitLambda } from '../constructs/db-init-lambda';

export class DatabaseStack extends cdk.Stack {
  public database: rds.DatabaseInstance;
  public databaseName: string;
  public rootUserSecret: secrets.Secret;
  public vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16_3,
    });
    const instanceType = ec2.InstanceType.of(
      ec2.InstanceClass.T3,
      ec2.InstanceSize.MICRO
    );
    const port = 5432;
    this.databaseName = 'gnome';

    this.rootUserSecret = new secrets.Secret(
      this,
      'registry-database-root-user',
      {
        secretName: 'registry-database-root-user',
        description: 'Credentials for root user on registry database',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'postgres' }),
          generateStringKey: 'password',
          passwordLength: 16,
          excludePunctuation: true,
        },
      }
    );

    this.vpc = new ec2.Vpc(this, 'registry-database-vpc', {
      vpcName: 'registry-database-vpc',
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'rds',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 18,
        },
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 20,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'registry-database-sg', {
      vpc: this.vpc,
      securityGroupName: 'registry-database-sg',
    });

    sg.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(port),
      `Allow port ${port} for database connection only within the VPC`
    );

    const parameterGroup = new rds.ParameterGroup(
      this,
      'ClusterParameterGroup',
      {
        engine,
        parameters: {
          'rds.force_ssl': '0',
        },
      }
    );

    this.database = new rds.DatabaseInstance(this, 'registry-database', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType,
      engine,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      port,
      securityGroups: [sg],
      databaseName: this.databaseName,
      credentials: rds.Credentials.fromSecret(this.rootUserSecret),
      parameterGroup,
    });

    new DatabaseInitLambda(this, 'DatabaseInitLambda', {
      database: this.database,
      vpc: this.vpc,
      rootUserSecret: this.rootUserSecret,
    });

    // SSM bastion for local dev tunneling to RDS/Redis
    // No SSH keys or open ports — access is SSM-only via IAM
    const bastion = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: new ec2.SecurityGroup(this, 'BastionSg', {
        vpc: this.vpc,
        description: 'Bastion host — no inbound, SSM outbound only',
        allowAllOutbound: true,
      }),
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value: bastion.instanceId,
      description: 'SSM bastion instance ID for local dev tunneling',
    });
  }
}
