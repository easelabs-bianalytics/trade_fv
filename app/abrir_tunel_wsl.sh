#!/usr/bin/env bash
# Abre o túnel SSM até o RDS do easelabs em 127.0.0.1:15432.
#
# SÓ FUNCIONA NO WSL. No Windows nativo o session-manager-plugin encerra a
# sessão assim que o stdin fecha, e todo comando disparado por ferramenta
# roda sem console — o túnel morre em segundos. No WSL ele sobe com stdin
# fechado e o WSL2 repassa a porta para o Windows.
#
# Uso interativo (terminal WSL, deixe aberto):
#   bash infra/rds/abrir_tunel_wsl.sh
#
# Uso em segundo plano (a partir do Windows):
#   wsl -e bash -lc "setsid nohup bash /mnt/d/Projetos/business_brain/bi/infra/rds/abrir_tunel_wsl.sh > /tmp/tunel_rds.log 2>&1 < /dev/null &"
#
# Conecte SEMPRE em host=127.0.0.1 (não localhost: ele tenta IPv6 antes e
# falha), port=15432, dbname=easelabs, sslmode=require, connect_timeout=15.
# As credenciais temporárias duram cerca de 1h; se a conexão travar, rode de
# novo. Pré-requisito no WSL: aws CLI v2, session-manager-plugin e
# `aws configure` com a chave base.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
REGION=sa-east-1
CLUSTER=cockpit-prod-cluster
ROLE_ARN=arn:aws:iam::595324409476:role/cockpit-prod-dev-ssm-access
RDS_HOST=cockpit-prod-db.cpuoqq0y8xnn.sa-east-1.rds.amazonaws.com
LOCAL_PORT=15432

# derruba túnel antigo (evita túnel zumbi segurando a porta)
pkill -f '^session-manager-plugin' 2>/dev/null || true

# credenciais temporárias (~1h)
read -r AK SK ST < <(aws sts assume-role --role-arn "$ROLE_ARN" \
  --role-session-name "$USER" --region $REGION \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST

# acha sozinho uma task com ECS Exec ativo (imune a redeploy)
read -r TASK_ARN RUNTIME_ID < <(aws ecs describe-tasks --cluster $CLUSTER --region $REGION \
  --tasks $(aws ecs list-tasks --cluster $CLUSTER --region $REGION --query 'taskArns' --output text) \
  --query "tasks[?enableExecuteCommand].[taskArn,containers[?managedAgents[?lastStatus=='RUNNING']].runtimeId|[0]] | [0]" \
  --output text)

aws ssm start-session --region $REGION \
  --target "ecs:${CLUSTER}_${TASK_ARN##*/}_${RUNTIME_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$RDS_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
