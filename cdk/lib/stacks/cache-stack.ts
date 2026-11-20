import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface Props extends cdk.StackProps {
  stage: Stage;
}

// What the venue syncs last read from their venues (one object per kind of data and venue, under a prefix per kind),
// so a sync reads the database only for what changed. Derived: a full pass rebuilds it, so it may be lost.
export class CacheStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'RegistryCache', {
      bucketName: `gnome-registry-cache-${props.stage}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // A sync that saves a bad snapshot can be put back on the one before.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
