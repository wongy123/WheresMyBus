resource "aws_secretsmanager_secret" "db" {
  name                           = "n11941073/assessment02/db"
  tags = {
    purpose      = "asssessment02"
    qut-username = "n11941073@qut.edu.au"
  }
  tags_all = {
    purpose      = "asssessment02"
    qut-username = "n11941073@qut.edu.au"
  }
}

resource "aws_secretsmanager_secret_version" "db_value" {
  secret_id                = "arn:aws:secretsmanager:ap-southeast-2:901444280953:secret:n11941073/assessment02/db-579bi4"
  secret_string            = jsonencode({"PGHOST":"database-1-instance-1.ce2haupt2cta.ap-southeast-2.rds.amazonaws.com","PGPORT":"5432","PGUSER":"s441","PGPASSWORD":"MLIbPu4bXQyn","PGDATABASE":"cohort_2025"})
}

resource "aws_cognito_user_pool_client" "wheresmybus" {
  access_token_validity                         = 60
  allowed_oauth_flows                           = ["code"]
  allowed_oauth_flows_user_pool_client          = true
  allowed_oauth_scopes                          = ["email", "openid", "profile"]
  auth_session_validity                         = 3
  callback_urls                                 = ["https://d84l1y8p4kdic.cloudfront.net", "https://n11941073.wheresmybus.cab432.com/api/auth/cognito/callback"]
  enable_propagate_additional_user_context_data = false
  enable_token_revocation                       = true
  explicit_auth_flows                           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH", "ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH"]
  id_token_validity                             = 60
  logout_urls                                   = []
  name                                          = "WheresMyBus"
  prevent_user_existence_errors                 = "ENABLED"
  read_attributes                               = []
  refresh_token_validity                        = 5
  supported_identity_providers                  = ["COGNITO", "Google"]
  user_pool_id                                  = "ap-southeast-2_itQrNJum0"
  write_attributes                              = []
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_identity_provider" "google" {
  attribute_mapping = {
    email       = "email"
    family_name = "family_name"
    given_name  = "given_name"
    picture     = "picture"
    username    = "sub"
  }
  idp_identifiers = []
  provider_details = {
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_scopes              = "openid email profile"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    client_id                     = "" # insert here
    client_secret                 = "" # insert here
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
  }
  provider_name = "Google"
  provider_type = "Google"
  user_pool_id  = "ap-southeast-2_itQrNJum0"
}

resource "aws_elasticache_cluster" "n11941073" {
  auto_minor_version_upgrade   = "true"
  availability_zone            = "ap-southeast-2a"
  az_mode                      = "single-az"
  cluster_id                   = "n11941073-wheresmybus-realtimegtfs"
  engine                       = "memcached"
  engine_version               = "1.6.22"
  ip_discovery                 = "ipv4"
  maintenance_window           = "sat:15:00-sat:16:00"
  network_type                 = "ipv4"
  node_type                    = "cache.t4g.micro"
  num_cache_nodes              = 1
  parameter_group_name         = "default.memcached1.6"
  port                         = 11211
  security_group_ids           = ["sg-078997505ad1c6bbc"]
  snapshot_retention_limit     = 0
  subnet_group_name            = "cab432-subnets"
  tags = {
    purpose      = "assessment02"
    qut-username = "n11941073@qut.edu.au"
  }
  tags_all = {
    purpose      = "assessment02"
    qut-username = "n11941073@qut.edu.au"
  }
  transit_encryption_enabled = false
}
resource "aws_cognito_user_group" "users" {
  name         = "Users"
  precedence   = 0
  user_pool_id = "ap-southeast-2_itQrNJum0"
}

resource "aws_cognito_user_group" "admins" {
  name         = "Admins"
  precedence   = 0
  user_pool_id = "ap-southeast-2_itQrNJum0"
}

resource "aws_ssm_parameter" "n11941073_url" {
  arn             = "arn:aws:ssm:ap-southeast-2:901444280953:parameter/n11941073/url"
  data_type       = "text"
  description     = "URL for ec2 instance"
  name            = "/n11941073/url"
  tags = {
    qut-username = "n11941073@qut.edu.au"
  }
  tags_all = {
    qut-username = "n11941073@qut.edu.au"
  }
  tier             = "Standard"
  type             = "String"
  value            = "https://n11941073.wheresmybus.cab432.com"
}

resource "aws_cognito_user_pool" "n11941073_wheresmybus" {
  auto_verified_attributes   = ["email"]
  deletion_protection        = "ACTIVE"
  mfa_configuration          = "ON"
  name                       = "n11941073-WheresMyBus"
  tags = {
    qut-username = "n11941073@qut.edu.au"
  }
  tags_all = {
    qut-username = "n11941073@qut.edu.au"
  }
  user_pool_tier      = "ESSENTIALS"
  username_attributes = []
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 2
    }
  }
  admin_create_user_config {
    allow_admin_create_user_only = false
  }
  email_configuration {
    email_sending_account  = "DEVELOPER"
    from_email_address     = "CAB432 logins <logins@cab432.com>"
    source_arn             = "arn:aws:ses:ap-southeast-2:901444280953:identity/cab432.com"
  }
  password_policy {
    minimum_length                   = 6
    password_history_size            = 0
    require_lowercase                = false
    require_numbers                  = false
    require_symbols                  = false
    require_uppercase                = false
    temporary_password_validity_days = 7
  }
  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "email"
    required                 = true
    string_attribute_constraints {
      max_length = "2048"
      min_length = "0"
    }
  }
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD"]
  }
  software_token_mfa_configuration {
    enabled = false
  }
  username_configuration {
    case_sensitive = false
  }
  verification_message_template {
    default_email_option  = "CONFIRM_WITH_CODE"
  }
}

resource "aws_s3_bucket" "n11941073_wheresmybus" {
  bucket              = "n11941073-wheresmybus"
  object_lock_enabled = false
  tags = {
    purpose      = "assessment02"
    qut-username = "n11941073@qut.edu.au"
  }
  tags_all = {
    purpose      = "assessment02"
    qut-username = "n11941073@qut.edu.au"
  }
}

resource "aws_route53_record" "n11941073_cname" {
  name                             = "n11941073.wheresmybus.cab432.com"
  records                          = ["ec2-3-107-161-122.ap-southeast-2.compute.amazonaws.com"]
  ttl                              = 60
  type                             = "CNAME"
  zone_id                          = "Z02680423BHWEVRU2JZDQ"
}
